import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { delegateRouted, locateCli, workingDirectory } from './runner.mjs'
import { getUsage, sanitizeDiagnostic } from '../shared/usage.mjs'
import { codexProfileHome } from '../shared/codex.mjs'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { getJobHistory, recordJob } from './history.mjs'
import { runPipeline } from './pipeline.mjs'
import { makeRoomForJob } from './job-registry.mjs'

const providers = ['opencode','claude','gemini','codex']
const server = new Server({name:'agent-subscription-bridge',version:'0.1.0'},{capabilities:{tools:{}}})
const jobs = new Map()
const MAX_LIVE_JOBS = 8

const delegateSchema = {
  type:'object',properties:{
    provider:{type:'string',enum:providers},directory:{type:'string',description:'Absolute project directory'},
    prompt:{type:'string',minLength:1},model:{type:'string'},effort:{type:'string'},
    account:{type:'string',enum:['pro-1','pro-2'],description:'Required when provider is codex; each profile authenticates separately.'},
    fallback:{type:'object',properties:{provider:{type:'string',enum:providers},account:{type:'string',enum:['pro-1','pro-2']},model:{type:'string'},effort:{type:'string'}},required:['provider'],additionalProperties:false,description:'Optional single explicit fallback. Codex profile to Codex profile switching is disabled.'},
    allowWrites:{type:'boolean',default:false}
  },required:['provider','directory','prompt'],additionalProperties:false
}

const fallbackSchema = { type:'object',properties:{provider:{type:'string',enum:providers},account:{type:'string',enum:['pro-1','pro-2']},model:{type:'string'},effort:{type:'string'}},required:['provider'],additionalProperties:false }
const pipelineSchema = {
  type:'object',properties:{
    repoDirectory:{type:'string',description:'Absolute path inside the repository to coordinate from'},
    task:{type:'string',minLength:1,maxLength:18000},
    plannerProvider:{type:'string',enum:providers},plannerAccount:{type:'string',enum:['pro-1','pro-2']},plannerModel:{type:'string'},plannerEffort:{type:'string'},plannerFallback:fallbackSchema,
    implementerProvider:{type:'string',enum:providers},implementerAccount:{type:'string',enum:['pro-1','pro-2']},implementerModel:{type:'string'},implementerEffort:{type:'string'},implementerFallback:fallbackSchema,
    reviewerProvider:{type:'string',enum:providers},reviewerAccount:{type:'string',enum:['pro-1','pro-2']},reviewerModel:{type:'string'},reviewerEffort:{type:'string'},reviewerFallback:fallbackSchema,
    verification:{type:'string',enum:['git-diff-check','npm-test','npm-check','npm-codex-check','python-unittest','go-test','cargo-test','pytest']},
    maxRounds:{type:'integer',minimum:1,maximum:2,default:1},
  },required:['repoDirectory','task','plannerProvider','implementerProvider','reviewerProvider','verification'],additionalProperties:false,
}

function accountId(args) { return args.provider === 'codex' ? args.account : 'default' }

function addJob(args, executeJob = ({ signal }) => delegateRouted(args.provider, args, { signal, fallback:args.fallback })) {
  makeRoomForJob(jobs, MAX_LIVE_JOBS)
  const now = Date.now()
  const id = randomUUID()
  const controller = new AbortController()
  const job = { id, provider:args.provider, accountId:accountId(args), status:'queued', createdAt:now, updatedAt:now, controller }
  jobs.set(id, job)
  const save = () => {
    recordJob({
      id:job.id, provider:job.provider, accountId:job.accountId,
      status:job.result?.fallbackUsed ? 'fallback' : job.status,
      createdAt:job.createdAt, updatedAt:job.updatedAt,
      durationMs:job.finishedAt === undefined ? undefined : job.finishedAt - job.createdAt,
      ok:job.result?.fallbackUsed ? false : job.result?.ok, exitCode:job.result?.exitCode,
      error:job.result?.fallbackUsed ? job.result.primaryError : job.error,
    }).catch(() => {})
    if (job.finishedAt !== undefined && job.result?.fallbackUsed && job.result.provider) {
      recordJob({
        id:`${job.id}:fallback`, provider:job.result.provider,
        accountId:job.result.provider === 'codex' ? args.fallback?.account ?? 'default' : 'default',
        status:job.result.ok ? 'completed' : 'failed', createdAt:job.createdAt, updatedAt:job.finishedAt,
        durationMs:job.finishedAt - job.createdAt, ok:job.result.ok, exitCode:job.result.exitCode, error:job.result.ok ? undefined : job.result.error,
      }).catch(() => {})
    }
    if (job.finishedAt !== undefined && Array.isArray(job.result?.agents)) {
      for (const stage of job.result.agents) {
        recordJob({
          id:`${job.id}:${stage.role}`, provider:stage.provider, accountId:stage.accountId,
          status:stage.ok ? 'completed' : 'failed', createdAt:job.createdAt, updatedAt:job.finishedAt,
          durationMs:job.finishedAt - job.createdAt, ok:stage.ok,
        }).catch(() => {})
      }
    }
  }
  save()
  job.promise = Promise.resolve().then(async () => {
    if (job.controller.signal.aborted) throw new Error('Agent cancelled')
    job.status = 'running'
    job.updatedAt = Date.now()
    save()
    job.result = await executeJob({ signal:job.controller.signal, onStage:(stage, detail = {}) => { job.stage = stage; Object.assign(job, detail); job.updatedAt = Date.now() } })
    job.status = job.result.ok ? 'completed' : 'failed'
    if (!job.result.ok) job.error = job.result.error
  }).catch(error => {
    job.error = sanitizeDiagnostic(error instanceof Error ? error.message : error)
    job.status = /cancel/i.test(job.error) ? 'cancelled' : 'failed'
  }).finally(() => {
    job.finishedAt = Date.now()
    job.updatedAt = job.finishedAt
    save()
    job.controller = undefined
  })
  return job
}

function publicJob(job) {
  return {
    id:job.id, provider:job.provider, accountId:job.accountId, status:job.status,
    createdAt:job.createdAt, updatedAt:job.updatedAt,
    ...(job.stage ? { stage:job.stage } : {}), ...(job.branch ? { branch:job.branch } : {}), ...(job.worktreePath ? { worktreePath:job.worktreePath } : {}),
    ...(job.finishedAt !== undefined ? { durationMs:job.finishedAt - job.createdAt } : {}),
    ...(job.result ? { result:job.result } : {}), ...(job.error ? { error:job.error } : {}),
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:[
  { name:'bridge_status',description:'Check local agent CLI discovery; no quota is consumed.',
    inputSchema:{type:'object',properties:{},additionalProperties:false} },
  { name:'bridge_usage',description:'Read cached or server-reported subscription usage for OpenCode Go, two isolated Codex profiles and Google AI Pro. This read-only tool does not run a model prompt.',
    inputSchema:{type:'object',properties:{directory:{type:'string',description:'Absolute active project directory for the directory-scoped OpenCode usage reading. If omitted, OpenCode Go is reported unavailable; other provider readings remain available.'},force:{type:'boolean',default:false,description:'Request a refresh, subject to provider rate limits and backoff.'}},additionalProperties:false} },
  { name:'bridge_history',description:'Read recent local delegation history by provider/account. History stores job metadata only; prompts and responses are not persisted.',
    inputSchema:{type:'object',properties:{provider:{type:'string',enum:providers},account:{type:'string',enum:['pro-1','pro-2']},limit:{type:'integer',minimum:1,maximum:100,default:50}},additionalProperties:false} },
  { name:'start_agent_job',description:'Start a cancellable asynchronous delegation job; use get_agent_job to read its status and result.',inputSchema:delegateSchema },
  { name:'get_agent_job',description:'Read the status or completed result of a delegation job.',inputSchema:{type:'object',properties:{jobId:{type:'string'}},required:['jobId'],additionalProperties:false} },
  { name:'cancel_agent_job',description:'Cancel a running delegation job. Cancellation stops the local CLI process when supported.',inputSchema:{type:'object',properties:{jobId:{type:'string'}},required:['jobId'],additionalProperties:false} },
  { name:'start_pipeline_job',description:'Run a planner, implementer, independent reviewer, and deterministic verifier. Editing occurs only in a new Git worktree and requires BRIDGE_ENABLE_WRITES=1. The branch/worktree are preserved; this tool never merges or pushes.',inputSchema:pipelineSchema },
  { name:'delegate_agent',description:'Delegate a self-contained task to a local OpenCode, Codex, Claude Code or Antigravity CLI using existing authentication. Read-only by default; editing requires owner opt-in. Codex requires an explicit isolated profile.',
    inputSchema:delegateSchema }
]}))
server.setRequestHandler(CallToolRequestSchema, async ({params}) => {
  const fail = e => ({isError:true,content:[{type:'text',text:sanitizeDiagnostic(e instanceof Error ? e.message : e)}]})
  if (params.name === 'bridge_status') {
    const report = Object.fromEntries(await Promise.all(providers.map(async p => {
      try { return [p,{available:true,executable:await locateCli(p)}] }
      catch (err) { return [p,{available:false,detail:sanitizeDiagnostic(err.message)}] }
    })))
    const root = process.env.USERPROFILE || process.env.HOME || homedir()
    const codexProfiles = Object.fromEntries(['pro-1','pro-2'].map(account => [account, {profileDirectoryExists:existsSync(codexProfileHome(root,account)), authentication:'Use bridge_usage to read through the authenticated profile; credentials are never inspected.'}]))
    return {content:[{type:'text',text:JSON.stringify({providers:report,codexProfiles},null,2)}]}
  }
  if (params.name === 'bridge_usage') {
    try {
      const requestedDirectory = params.arguments?.directory
      const usage = await getUsage({ ...(requestedDirectory ? { directory:workingDirectory(requestedDirectory) } : {}), force:params.arguments?.force === true })
      return {content:[{type:'text',text:JSON.stringify({providers:usage,note:'Percentages describe server-reported quota windows and do not guarantee that a next request will be available.'},null,2)}]}
    } catch (err) { return fail(err) }
  }
  const args = params.arguments || {}
  if (params.name === 'bridge_history') {
    if (args.provider === 'codex' && args.account && !['pro-1','pro-2'].includes(args.account)) return fail('Select Codex profile pro-1 or pro-2 explicitly.')
    try {
      const records = await getJobHistory({provider:args.provider,accountId:args.account,limit:args.limit})
      return {content:[{type:'text',text:JSON.stringify({records},null,2)}]}
    } catch (err) { return fail(err) }
  }
  if (params.name === 'start_agent_job') {
    if (!providers.includes(args.provider)) return fail('Invalid provider')
    if (args.provider === 'codex' && !['pro-1','pro-2'].includes(args.account)) return fail('Select Codex profile pro-1 or pro-2 explicitly; accounts are never switched automatically.')
    try { return {content:[{type:'text',text:JSON.stringify({job:publicJob(addJob(args))})}]} }
    catch (err) { return fail(err) }
  }
  if (params.name === 'start_pipeline_job') {
    if (process.env.BRIDGE_ENABLE_WRITES !== '1') return fail('Owner must explicitly enable BRIDGE_ENABLE_WRITES=1 before starting an editing pipeline.')
    try {
      const job = addJob({ provider:'pipeline' }, ({ signal, onStage }) => runPipeline(args, {
        signal, onStage,
        ...(process.env.BRIDGE_WORKTREE_ROOT ? { worktreeRoot:process.env.BRIDGE_WORKTREE_ROOT } : {}),
      }))
      return {content:[{type:'text',text:JSON.stringify({job:publicJob(job)})}]}
    } catch (err) { return fail(err) }
  }
  if (params.name === 'get_agent_job') {
    const job = jobs.get(args.jobId)
    if (job) return {content:[{type:'text',text:JSON.stringify({job:publicJob(job)},null,2)}]}
    const historical = (await getJobHistory({limit:100})).find(item => item.id === args.jobId)
    if (historical) return {content:[{type:'text',text:JSON.stringify({job:historical},null,2)}]}
    return fail('Unknown delegation job')
  }
  if (params.name === 'cancel_agent_job') {
    const job = jobs.get(args.jobId)
    if (!job) return fail('Unknown delegation job')
    if (!['queued','running'].includes(job.status)) return {content:[{type:'text',text:JSON.stringify({job:publicJob(job)})}]}
    job.status = 'cancelling'
    job.updatedAt = Date.now()
    job.controller?.abort()
    return {content:[{type:'text',text:JSON.stringify({job:publicJob(job)})}]}
  }
  if (params.name !== 'delegate_agent') return fail('Unknown tool')
  if (!providers.includes(args.provider)) return fail('Invalid provider')
  if (args.provider === 'codex' && args.account !== 'pro-1' && args.account !== 'pro-2') return fail('Select Codex profile pro-1 or pro-2 explicitly; accounts are never switched automatically.')
  try {
    const result = await delegateRouted(args.provider,args,{ fallback:args.fallback })
    return {isError:!result.ok,content:[{type:'text',text:JSON.stringify(result,null,2)}]}
  } catch (err) {return fail(err instanceof Error ? err.message : String(err))}
})
await server.connect(new StdioServerTransport())
