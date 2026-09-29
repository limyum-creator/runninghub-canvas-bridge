// Durable receipts, written before dispatch. Uncertain commands are never replayed.
import { mkdirSync, readdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export class CommandJournal {
  constructor(root) {this.root=root;mkdirSync(root,{recursive:true,mode:0o700});}
  save(id,record,result) {
    const name=createHash('sha256').update(id).digest('hex')+'.json',temp=join(this.root,name+'.'+randomUUID()+'.tmp');
    const fd=openSync(temp,'wx',0o600);
    try {writeFileSync(fd,JSON.stringify({id,record,result}));fsyncSync(fd);} finally {closeSync(fd);}
    renameSync(temp,join(this.root,name));
  }
  load() {
    return readdirSync(this.root).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).map(name=>{
      const entry=JSON.parse(readFileSync(join(this.root,name),'utf8'));
      if(!entry.id || !entry.record) throw new Error('COMMAND_JOURNAL_CORRUPT');
      if(['queued','dispatched'].includes(entry.record.state)) {
        const dispatched=entry.record.state==='dispatched';
        entry.record.state=dispatched?'unknown':'interrupted';
        entry.result={ok:false,commandId:entry.id,errorCode:dispatched?'COMMAND_OUTCOME_UNKNOWN':'COMMAND_NOT_DISPATCHED',error:dispatched?'Bridge restarted after dispatch. Inspect this node and platform task history; never resubmit blindly.':'Bridge restarted before dispatch. This request was not sent to the page.'};
        this.save(entry.id,entry.record,entry.result);
      }
      return entry;
    });
  }
}
