import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { delegate, locateCli } from './runner.mjs'

const providers = ['opencode','claude','gemini']
const server = new Server({name:'agent-subscription-bridge',version:'0.1.0'},{capabilities:{tools:{}}})

server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:[
  { name:'bridge_status',description:'Check local agent CLI discovery; no quota is consumed.',
    inputSchema:{type:'object',properties:{},additionalProperties:false} },
  { name:'delegate_agent',description:'Delegate a self-contained task to a local OpenCode, Claude Code or Gemini CLI using existing authentication. Read-only by default; editing requires owner opt-in.',
    inputSchema:{type:'object',properties:{
      provider:{type:'string',enum:providers},directory:{type:'string',description:'Absolute project directory'},
      prompt:{type:'string',minLength:1},model:{type:'string'},effort:{type:'string'},
      allowWrites:{type:'boolean',default:false}
    },required:['provider','directory','prompt'],additionalProperties:false} }
]}))
server.setRequestHandler(CallToolRequestSchema, async ({params}) => {
  const fail = e => ({isError:true,content:[{type:'text',text:String(e)}]})
  if (params.name === 'bridge_status') {
    const report = Object.fromEntries(providers.map(p => {
      try { return [p,{available:true,executable:locateCli(p)}] }
      catch (err) { return [p,{available:false,detail:err.message}] }
    }))
    return {content:[{type:'text',text:JSON.stringify({providers:report,usage:'Actual remaining quota telemetry is NOT implemented in this draft.'},null,2)}]}
  }
  if (params.name !== 'delegate_agent') return fail('Unknown tool')
  const args = params.arguments || {}
  if (!providers.includes(args.provider)) return fail('Invalid provider')
  try {
    const result = await delegate(args.provider,args)
    return {isError:!result.ok,content:[{type:'text',text:JSON.stringify(result,null,2)}]}
  } catch (err) {return fail(err instanceof Error ? err.message : String(err))}
})
await server.connect(new StdioServerTransport())
