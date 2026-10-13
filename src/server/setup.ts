import { createInterface } from 'node:readline/promises';
import { Store } from './store.js';
import { setPassword } from './auth.js';
// Pipe from a secure terminal prompt; password never appears in process arguments.
const reader=createInterface({input:process.stdin});
const lines=reader[Symbol.asyncIterator]();
const line=await lines.next();reader.close();
if(line.done)throw new Error('표준 입력으로 비밀번호 한 줄을 전달하세요.');
const store=new Store(process.env.KANBAN_DB??'data/kanban.sqlite');
try{setPassword(store,line.value);console.log('소유자 비밀번호 설정 완료');}finally{store.close();}
