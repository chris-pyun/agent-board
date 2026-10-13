// Browser QA only. This script is not imported by the production entry point.
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/server/app.js';
import type { Runner } from '../src/server/runs.js';
const root=mkdtempSync(join(tmpdir(),'kanban-preview-'));
const timers=new Map<string,ReturnType<typeof setTimeout>>();
const endings=new Map<string,Parameters<Runner['launch']>[1]>();
const runner:Runner={
  ready:()=>true,
  launch(context,end){
    endings.set(context.run.id,end);service.runs.start(context.token,context.run.id,{});
    timers.set(context.run.id,setTimeout(()=>{
      service.runs.submit(context.token,context.run.id,{summary:'브라우저 화면 검사용 더미 결과입니다. 실제 CLI를 실행하지 않았습니다.',changedFiles:[],tests:[{name:'CLI 테스트',status:'not_run',details:'화면 검사용 더미 실행'}]});
      end('succeeded',null,true);timers.delete(context.run.id);
    },1500));
  },
  cancel(id){const timer=timers.get(id);if(timer)clearTimeout(timer);timers.delete(id);endings.get(id)?.('cancelled','화면 검사에서 취소',true);}
};
const service=createApp({dbPath:join(root,'test.sqlite'),password:'ui-test-password-123',runner});
const server=service.app.listen(0,'127.0.0.1',()=>{const a=server.address();if(a&&typeof a!=='string')console.log(`Browser QA: http://127.0.0.1:${a.port}; temporary DB: ${service.store.path}`);});
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{for(const timer of timers.values())clearTimeout(timer);server.closeAllConnections();server.close(()=>{service.close();process.exit(0);});});
