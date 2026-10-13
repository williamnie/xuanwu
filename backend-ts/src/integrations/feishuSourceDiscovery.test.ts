import { expect, test } from "bun:test";
import { openDatabase } from "../db/database.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startFeishuDiscovery, captureFeishuDiscovery, readFeishuDiscovery, consumeFeishuDiscovery } from "./feishuSourceDiscovery.ts";
import { normalizeFeishuMessageEvent } from "./feishuEvents.ts";
test("discovery only captures matching fresh authenticated-adapter facts, bounded and volatile", async () => {
 const root=mkdtempSync(join(tmpdir(),"xw-discovery-"));const db=await openDatabase({stateDir:root});
 try {
  const now=Date.now();const session=startFeishuDiscovery(db,now,"revision-1");
  expect(readFeishuDiscovery(db,session.id,now)?.config_revision).toBe("revision-1");
  const message=(text:string,time=now)=>normalizeFeishuMessageEvent({sender:{sender_type:"user",sender_id:{open_id:"ou_candidate"}},message:{message_id:"m1",chat_id:"oc_candidate",chat_type:"group",create_time:String(time),content:JSON.stringify({text})}});
  expect(captureFeishuDiscovery(db,message("ordinary private text"),now)).toBe(false);
  expect(readFeishuDiscovery(db,session.id,now)?.candidates).toHaveLength(0);
  expect(captureFeishuDiscovery(db,message(session.challenge,now-20_000),now)).toBe(true);
  expect(readFeishuDiscovery(db,session.id,now)?.candidates).toHaveLength(0);
  expect(captureFeishuDiscovery(db,message(session.challenge),now)).toBe(true);
  captureFeishuDiscovery(db,message(session.challenge),now);
  const snapshot=readFeishuDiscovery(db,session.id,now)!;expect(snapshot.candidates).toHaveLength(1);
  expect(Object.keys(snapshot.candidates[0]!)).toEqual(["id","chat_id","chat_type","user_id","message_id"]);
  consumeFeishuDiscovery(db,session.id);expect(captureFeishuDiscovery(db,message(session.challenge),now)).toBe(true);
  expect(readFeishuDiscovery(db,session.id,now+120_001)).toBeNull();
  expect(captureFeishuDiscovery(db,message(session.challenge),now+120_001)).toBe(true);
  expect(db.sqlite.query("select count(*) as n from external_events").get()).toEqual({n:0});
 } finally {db.close();rmSync(root,{recursive:true,force:true});}
});
