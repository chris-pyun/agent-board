import { createApp } from './app.js';
const port=Number(process.env.KANBAN_PORT??3000);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('KANBAN_PORT must be 1..65535');
const instance=createApp({dbPath:process.env.KANBAN_DB??'data/kanban.sqlite'});
const server=instance.app.listen(port,'127.0.0.1',()=>console.log(`Kanban: http://127.0.0.1:${port}`));
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>server.close(()=>{instance.close();process.exit(0);}));
