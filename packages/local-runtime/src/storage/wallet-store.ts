import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hash } from '../simulation/common.js';
import { AppError } from '../../../contracts/src/errors.js';
import type { WalletPreparation, WalletRunView } from '../../../contracts/src/wallet.js';
export type HumanResponseCommand={key:string;fingerprint:string;proof:string;result:WalletRunView|null;abandoned?:boolean};
export class WalletStore {
 private readonly db:DatabaseSync;
 constructor(path:string){mkdirSync(dirname(path),{recursive:true});this.db=new DatabaseSync(path);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS preparations (id TEXT PRIMARY KEY,body TEXT NOT NULL,checksum TEXT NOT NULL); CREATE TABLE IF NOT EXISTS human_responses (id TEXT PRIMARY KEY,body TEXT NOT NULL,checksum TEXT NOT NULL);');}
 list():WalletPreparation[]{return this.db.prepare('SELECT body,checksum FROM preparations ORDER BY rowid DESC').all().map(row=>{try{const p=JSON.parse(String(row['body'])) as WalletPreparation;if(hash(p)!==row['checksum']||!p.preparation_id||!['processing','ready','failed'].includes(p.status))throw Error('invalid preparation');return p;}catch{throw new AppError(503,'wallet_store_invalid','Saved permissions could not be verified. Your data has been preserved.');}});}
 get(id:string):WalletPreparation{const p=this.list().find(p=>p.preparation_id===id);if(!p)throw new AppError(404,'preparation_not_found','This permission review could not be found.');return p;}
 save(p:WalletPreparation):void{this.db.prepare('INSERT INTO preparations VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,checksum=excluded.checksum').run(p.preparation_id,JSON.stringify(p),hash(p));}
 response(key:string):HumanResponseCommand|null{const row=this.db.prepare('SELECT body,checksum FROM human_responses WHERE id=?').get(key);if(!row)return null;const value=JSON.parse(String(row['body'])) as HumanResponseCommand;if(hash(value)!==row['checksum']||value.key!==key)throw new AppError(503,'wallet_store_invalid','The saved response could not be verified.');return value;}
 saveResponse(command:HumanResponseCommand):void{this.db.prepare('INSERT INTO human_responses VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,checksum=excluded.checksum').run(command.key,JSON.stringify(command),hash(command));}
 removeResponse(key:string):void{this.db.prepare('DELETE FROM human_responses WHERE id=?').run(key);}
 close():void{this.db.close();}
}
