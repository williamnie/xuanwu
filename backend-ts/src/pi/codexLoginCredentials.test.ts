import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { createCodexLoginService, CODEX_REFRESH_THRESHOLD_MS, CODEX_REFRESH_BACKOFF_MS } from "./codexLoginCredentials.ts";
import { createPiModelRuntime, registerCodexLoginService } from "./piModelRuntime.ts";
import { openDatabase } from "../db/database.ts";
import { getPiSupervisor, updatePiSupervisor } from "../db/repositories/pi.ts";
import { createDefaultRouter } from "../http/server.ts";
import { CodexAdapter } from "../providers/codex/adapter.ts";
import { CodexExecutorProvider } from "../providers/codex/provider.ts";
import { effectiveCodexHome } from "../config/codexServer.ts";

const roots: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); while (roots.length) rmSync(roots.pop()!, { recursive:true, force:true }); });
const now = Date.now();
function jwt(payload: object) { return `synthetic.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.unsigned`; }
function fixture(role: "core" | "worker" | "replay" = "core", expires = now + 3_600_000) {
  const root = mkdtempSync(join(tmpdir(), "xw-f1-")); roots.push(root);
  const home = join(root, "codex"); mkdirSync(home);
  const path = join(home, "auth.json");
  const key = {};
  let calls = 0;
  const write = (expiry: number, account = "synthetic-account") => writeFileSync(path, JSON.stringify({
    auth_mode:"chatgpt", tokens: { access_token:jwt({exp:Math.floor(expiry/1000), "https://api.openai.com/auth":{chatgpt_account_id:account}}),
      refresh_token:"synthetic-refresh-never-export", id_token:jwt({"https://api.openai.com/auth":{chatgpt_account_id:account}}), account_id:account }
  }));
  write(expires);
  const binding = {home, managedHome:home, key, unavailable:undefined as string | undefined,
    refresh:async () => { calls++; await Promise.resolve(); write(now + 3_600_000); }};
  const service = createCodexLoginService({ role, binding:() => binding, now:() => now });
  return {root,home,path,write,binding,service,calls:() => calls};
}

test("maps only access/expiry/account metadata; pure status and reads never write either store", async () => {
  const f=fixture(); const before=readFileSync(f.path,"utf8");
  const credential=await f.service.credentials.read("openai-codex");
  expect(credential).toMatchObject({type:"oauth",refresh:"",expires:Math.floor((now+3_600_000)/1000)*1000,accountId:"synthetic-account"});
  expect(Object.keys(credential!)).toEqual(["type","access","refresh","expires","accountId"]);
  const status=f.service.status(); expect(status.available).toBe(true);
  for(const forbidden of ["synthetic-account","synthetic-refresh-never-export","access_token","id_token","email","account_id"]) expect(JSON.stringify(status)).not.toContain(forbidden);
  expect(f.calls()).toBe(0); expect(readFileSync(f.path,"utf8")).toBe(before);
  expect(existsSync(join(f.root,"pi-runtime/agent/auth.json"))).toBe(false);
});

test("core refreshes below 30 minutes, rereads, and coalesces concurrent requests on the managed binding", async () => {
  const f=fixture("core",now+CODEX_REFRESH_THRESHOLD_MS-2000);
  const before=readFileSync(f.path,"utf8");
  const values=await Promise.all(Array.from({length:15},()=>f.service.credentials.read("openai-codex")));
  expect(f.calls()).toBe(1); expect(new Set(values.map(x => x?.type === "oauth" ? x.expires : 0)).size).toBe(1);
  expect(readFileSync(f.path,"utf8")).not.toBe(before); // Only fake Codex writes.
});

test("core does not refresh at or above the threshold and status never refreshes expired tokens", async () => {
  const f=fixture("core",Math.ceil(now/1000)*1000+CODEX_REFRESH_THRESHOLD_MS);
  await f.service.maintain(); expect(f.calls()).toBe(0);
  f.write(now-1000); expect(f.service.status().error).toBe("codex_login_expired"); expect(f.calls()).toBe(0);
});

test("unchanged refresh backs off across readers for five minutes, but expiry immediately retries", async () => {
  const start=Math.floor(now/1000)*1000;
  const f=fixture("core",start+7*60_000);let clock=start;let calls=0;
  f.binding.refresh=async()=>{calls++;};
  const readers=Array.from({length:2},()=>createCodexLoginService({role:"core",binding:()=>f.binding,now:()=>clock}));
  const before=readFileSync(f.path,"utf8");
  for(let i=0;i<10;i++) await readers[i%2].credentials.read("openai-codex");
  expect(calls).toBe(1);
  clock=start+CODEX_REFRESH_BACKOFF_MS-1;
  await readers[1].maintain();expect(calls).toBe(1);
  clock++;await readers[1].maintain();expect(calls).toBe(2);
  clock=start+7*60_000;
  await expect(readers[0].credentials.read("openai-codex")).rejects.toThrow("codex_login_expired");
  expect(calls).toBe(3);expect(readFileSync(f.path,"utf8")).toBe(before);
});

test("failed refresh preserves valid model credentials with a status warning, retries after backoff or expiry", async () => {
  const start=Math.floor(now/1000)*1000;
  const f=fixture("core",start+7*60_000);let clock=start;let calls=0;
  f.binding.refresh=async()=>{calls++;throw new Error("synthetic private provider error");};
  const service=createCodexLoginService({role:"core",binding:()=>f.binding,now:()=>clock});
  const before=readFileSync(f.path,"utf8");
  for(let i=0;i<10;i++) expect((await service.credentials.read("openai-codex"))?.type).toBe("oauth");
  expect(service.status()).toMatchObject({available:true,error:"codex_login_refresh_failed"});
  expect(await service.credentials.list()).toEqual([{providerId:"openai-codex",type:"oauth"}]);
  const runtime=await ModelRuntime.create({credentials:service.credentials,modelsPath:null,refreshOnCreate:false});
  expect((await runtime.getAuth("openai-codex"))?.auth.apiKey).toBeDefined();
  expect(calls).toBe(1);
  clock=start+CODEX_REFRESH_BACKOFF_MS;
  expect((await service.maintain()).type).toBe("oauth");expect(calls).toBe(2);
  clock=start+7*60_000;
  await expect(service.credentials.modify("openai-codex",async()=>{throw new Error("pi callback must not run");})).rejects.toThrow("codex_login_refresh_failed");
  expect(calls).toBe(3);expect(service.status().available).toBe(false);expect(readFileSync(f.path,"utf8")).toBe(before);
});

test("refresh failure cannot reuse a removed login or a changed account even before expiry", async () => {
  const f=fixture("core",now+60_000);
  f.binding.refresh=async()=>{rmSync(f.path);throw new Error("synthetic network failure");};
  await expect(f.service.credentials.read("openai-codex")).rejects.toThrow("codex_login_refresh_failed");
  expect(f.service.status().available).toBe(false);
  f.write(now+60_000);f.binding.key={};
  f.binding.refresh=async()=>f.write(now+3_600_000,"another-account");
  await expect(f.service.credentials.read("openai-codex")).rejects.toThrow("codex_login_account_mismatch");
  expect(f.service.status().available).toBe(false);
});

test("external token rotation and a replacement transport do not inherit stale backoff", async () => {
  const f=fixture("core",now+10*60_000);let calls=0;
  f.binding.refresh=async()=>{calls++;};
  await f.service.maintain();expect(calls).toBe(1);
  f.write(now+11*60_000);
  await f.service.maintain();expect(calls).toBe(2);
  f.binding.key={};await f.service.maintain();expect(calls).toBe(3);
});

test("worker modify rereads externally refreshed credentials, never executes pi callback or refreshes", async () => {
  const f=fixture("worker",now-1000); let callbacks=0;
  const fn=async()=> { callbacks++; return undefined; };
  await expect(f.service.credentials.modify("openai-codex",fn)).rejects.toMatchObject({code:"codex_login_expired"});
  f.write(now+60_000);
  expect((await f.service.credentials.modify("openai-codex",fn))?.type).toBe("oauth");
  expect(callbacks).toBe(0);expect(f.calls()).toBe(0);
});

test("core modify refreshes expired credentials and does not invoke pi's fn", async () => {
  const f=fixture("core",now-1000); let callbacks=0;
  await f.service.credentials.modify("openai-codex",async()=> {callbacks++;throw new Error("must not run");});
  expect(f.calls()).toBe(1);expect(callbacks).toBe(0);
  await expect(f.service.credentials.delete("openai-codex")).rejects.toMatchObject({code:"codex_login_read_only"});
});

test("home mismatch and disabled/unavailable provider fail closed before refresh", async () => {
  const f=fixture("core",now-1000);f.binding.managedHome=join(f.root,"other-home");
  expect(f.service.status().error).toBe("codex_login_home_mismatch");
  await expect(f.service.maintain()).rejects.toMatchObject({code:"codex_login_home_mismatch"});
  f.binding.managedHome=f.home;f.binding.unavailable="codex_provider_disabled";
  expect(f.service.status().available).toBe(false);
  await expect(f.service.maintain()).rejects.toMatchObject({code:"codex_provider_disabled"});expect(f.calls()).toBe(0);
});

test("refresh failure is classified without raw provider messages or credentials", async () => {
  const f=fixture("core",now-1000); const before=readFileSync(f.path,"utf8");
  f.binding.refresh=async()=>{throw new Error("synthetic-refresh-never-export synthetic-account");};
  await expect(f.service.maintain()).rejects.toMatchObject({message:"codex_login_refresh_failed"});
  expect(f.service.status().error).toBe("codex_login_refresh_failed");
  expect(JSON.stringify(f.service.status())).not.toContain("synthetic-account");expect(readFileSync(f.path,"utf8")).toBe(before);
});

test("refresh must produce a valid expiry and preserve account identity", async () => {
  const f=fixture("core",now-1000);
  f.binding.refresh=async()=>f.write(now-1000);
  await expect(f.service.maintain()).rejects.toMatchObject({code:"codex_login_expired"});
  f.binding.refresh=async()=>f.write(now+3_600_000,"another-synthetic-account");
  await expect(f.service.maintain()).rejects.toMatchObject({code:"codex_login_account_mismatch"});
});

test("pure status recovers after Codex externally replaces a failed login, and whitelists auth mode", async () => {
  const f=fixture("core",now-1000);
  f.binding.refresh=async()=>{throw new Error("synthetic failure");};
  await expect(f.service.maintain()).rejects.toThrow("codex_login_refresh_failed");
  f.write(now+3_600_000);
  const before=readFileSync(f.path,"utf8");
  expect(f.service.status().available).toBe(true);
  expect(readFileSync(f.path,"utf8")).toBe(before);
  writeFileSync(f.path,JSON.stringify({auth_mode:"synthetic-secret-must-not-echo",OPENAI_API_KEY:"synthetic-key"}));
  expect(f.service.status()).toMatchObject({configured:true,available:false,auth_mode:"",error:"codex_login_unsupported"});
  expect(JSON.stringify(f.service.status())).not.toContain("synthetic-secret");
});

test("missing, broken, API-key, malformed expiry, and account mismatch have safe classifications", () => {
  const f=fixture();
  const cases:[unknown,string][]=[
    [{auth_mode:"apikey",OPENAI_API_KEY:"synthetic-key"},"codex_login_unsupported"],
    [{auth_mode:"chatgpt",tokens:{access_token:jwt({"https://api.openai.com/auth":{chatgpt_account_id:"a"}})}},"codex_login_invalid_token"],
    [{auth_mode:"chatgpt",tokens:{access_token:jwt({exp:now/1000+3600,"https://api.openai.com/auth":{chatgpt_account_id:"a"}}),account_id:"b"}},"codex_login_account_mismatch"]
  ];
  for(const [raw,code] of cases){writeFileSync(f.path,JSON.stringify(raw));expect(f.service.status().error).toBe(code);}
  writeFileSync(f.path,"{");expect(f.service.status().error).toBe("invalid_auth_json");
  rmSync(f.path);expect(f.service.status().error).toBe("codex_login_missing");
});

test("real SDK auth and catalog paths cannot invoke pi refresh through the adapter", async () => {
  const f=fixture("worker",Date.now()+60_000);
  const originalFetch=globalThis.fetch;let network=0;
  globalThis.fetch=(async()=> {network++;throw new Error("network forbidden");}) as typeof fetch;
  try {
    const runtime=await ModelRuntime.create({credentials:f.service.credentials,modelsPath:null,refreshOnCreate:false});
    expect((await runtime.getAuth("openai-codex"))?.auth.apiKey).toBeDefined();
    f.write(now-1000);
    await expect(runtime.getAuth("openai-codex")).rejects.toThrow("codex_login_expired");
    const result=await runtime.refresh({allowNetwork:true,force:true,providers:["openai-codex"]});
    expect(result.errors.has("openai-codex")).toBe(true);expect(network).toBe(0);
  }finally{globalThis.fetch=originalFetch;}
});

test("supervisor migration defaults stored, validates enum and persists a source without credentials", async () => {
  const f=fixture(); const db=await openDatabase({stateDir:join(f.root,"state")});cleanups.push(()=>db.close());
  expect(getPiSupervisor(db)?.credential_source).toBe("stored");
  const router=createDefaultRouter({database:db});
  const patch=(source:unknown)=>router.handle(new Request("http://fixture/api/pi/supervisor",{method:"PATCH",body:JSON.stringify({credential_source:source})}));
  expect((await patch("invalid")).status).toBe(400);
  expect((await patch("codex_login")).status).toBe(200);expect(getPiSupervisor(db)?.credential_source).toBe("codex_login");
  expect(readFileSync(f.path,"utf8")).toContain("synthetic-refresh-never-export");
});

test("selector keeps explicit stored lifecycle and isolated smoke paths separate; replay cannot refresh", async () => {
  const f=fixture("core",now-1000);const db=await openDatabase({stateDir:join(f.root,"state")});cleanups.push(()=>db.close());
  cleanups.push(registerCodexLoginService(db,f.service));updatePiSupervisor(db,{credential_source:"codex_login"});
  const sdk={ModelRuntime,readStoredCredential}; const authPath=join(f.root,"stored-auth.json");
  writeFileSync(authPath,JSON.stringify({"openai-codex":{type:"oauth",access:"synthetic-stored",refresh:"synthetic-stored-refresh",expires:Date.now()+3_600_000}}));
  const before=readFileSync(authPath,"utf8");
  const stored=await createPiModelRuntime(sdk,{database:db,mode:"stored",authPath,modelsPath:null,refreshOnCreate:false});
  expect((await stored.getAuth("openai-codex"))?.auth.apiKey).toBe("synthetic-stored");expect(f.calls()).toBe(0);
  const replay=await createPiModelRuntime(sdk,{database:db,mode:"replay",modelsPath:null,refreshOnCreate:false});
  await expect(replay.getAuth("openai-codex")).rejects.toThrow("codex_login_expired");expect(f.calls()).toBe(0);
  const smoke=await createPiModelRuntime(sdk,{mode:"smoke",authPath:join(f.root,"smoke.json"),modelsPath:null,refreshOnCreate:false});
  expect(await smoke.getAuth("openai-codex")).toBeUndefined();expect(f.calls()).toBe(0);
  const assistant=await createPiModelRuntime(sdk,{database:db,authPath,modelsPath:null,refreshOnCreate:false});
  expect((await assistant.getAuth("openai-codex"))?.auth.apiKey).not.toBe("synthetic-stored");expect(f.calls()).toBe(1);
  expect(readFileSync(authPath,"utf8")).toBe(before);
});

test("managed account RPC uses refreshToken without exporting account, and provider single-flights", async () => {
  const calls:unknown[]=[];let finish:()=>void=()=>{};
  const gate=new Promise<void>(r=>{finish=r;});
  const adapter=new CodexAdapter({async request(method,params){calls.push({method,params});if(method==="account/read"){await gate;return {account:{type:"chatgpt",email:"synthetic@example.invalid"}};}return {};}});
  const provider=new CodexExecutorProvider(adapter);
  const a=provider.refreshCodexLogin(),b=provider.refreshCodexLogin();finish();
  expect(await Promise.all([a,b])).toEqual([undefined,undefined]);
  expect(calls).toEqual([{method:"initialize",params:{clientInfo:{name:"xuanwu",version:"0.1.0"},capabilities:{experimentalApi:true}}},{method:"account/read",params:{refreshToken:true}}]);
});

test("transport and reader use the same explicit effective home resolution", () => {
  expect(effectiveCodexHome({env:{CODEX_HOME:"relative-home"},cwd:"/tmp/synthetic"})).toBe("/tmp/synthetic/relative-home");
  expect(effectiveCodexHome({env:{CODEX_HOME:"",HOME:"/tmp/synthetic-home"}})).toBe("/tmp/synthetic-home/.codex");
});

test("status is pure; discovery override selects once without persisting, validates source and rejects credential payloads", async () => {
  const f=fixture("worker",now-1000);const db=await openDatabase({stateDir:join(f.root,"state")});cleanups.push(()=>db.close());
  cleanups.push(registerCodexLoginService(db,f.service));
  const router=createDefaultRouter({database:db});
  const status=await router.handle(new Request("http://fixture/api/pi/oauth/openai-codex/status"));
  expect(await status.json()).toMatchObject({credential_source:"stored",codex_login:{available:false,error:"codex_login_expired",path:f.path,storage:"file"}});
  expect(f.calls()).toBe(0);
  const post=(body:unknown)=>router.handle(new Request("http://fixture/api/pi/provider-settings/openai-codex/test-connection",{method:"POST",body:JSON.stringify(body)}));
  expect((await post({credential_source:"invalid"})).status).toBe(400);
  expect((await post({credential_source:{access:"fake"}})).status).toBe(400);
  expect((await post({credential_source:"codex_login",token:"fake"})).status).toBe(400);
  const response=await post({credential_source:"codex_login"});
  expect(await response.json()).toMatchObject({ok:false,error:"codex_login_expired"});
  expect(getPiSupervisor(db)?.credential_source).toBe("stored");expect(f.calls()).toBe(0);
  const sources:unknown[]=[];
  const injected=createDefaultRouter({database:db,piOpenAICodexModelDiscovery:async(_db,_signal,source)=>{sources.push(source);return ["fixture-model"];}});
  const result=await injected.handle(new Request("http://fixture/api/pi/provider-settings/openai-codex/models",{method:"POST",body:JSON.stringify({credential_source:"codex_login"})}));
  expect(await result.json()).toMatchObject({ok:true,models:["fixture-model"]});expect(sources).toEqual(["codex_login"]);
  expect(getPiSupervisor(db)?.credential_source).toBe("stored");
});

test("login and logout always use stored SDK path while codex_login is selected, without querying the adapter", async () => {
  const {spyOn}=await import("bun:test");
  const f=fixture();const db=await openDatabase({stateDir:join(f.root,"state")});cleanups.push(()=>db.close());
  let touched=0;
  const service=createCodexLoginService({role:"core",binding:()=>{touched++;throw new Error("must not inspect Codex home during stored lifecycle");}});
  cleanups.push(registerCodexLoginService(db,service));updatePiSupervisor(db,{credential_source:"codex_login"});
  const authPath=join(f.root,"state/pi-runtime/agent/auth.json");mkdirSync(join(f.root,"state/pi-runtime/agent"),{recursive:true});
  const before=readFileSync(f.path,"utf8");const options:unknown[]=[];
  const mock=spyOn(ModelRuntime,"create").mockImplementation(async value=>{
    options.push(value);
    return {
      async login(_id:unknown,_type:unknown,interaction:any){
        interaction.notify({type:"auth_url",url:"https://fixture.invalid/oauth"});
        const credentials={type:"oauth",access:"synthetic-independent",refresh:"synthetic-independent-refresh",expires:Date.now()+3_600_000};
        writeFileSync(authPath,JSON.stringify({"openai-codex":credentials}));return credentials;
      },
      async logout(){writeFileSync(authPath,"{}");}
    } as any;
  });
  try {
    const router=createDefaultRouter({database:db});
    expect((await router.handle(new Request("http://fixture/api/pi/oauth/openai-codex/login",{method:"POST"}))).status).toBe(200);
    expect((await router.handle(new Request("http://fixture/api/pi/oauth/openai-codex/logout",{method:"POST"}))).status).toBe(200);
    expect(options).toHaveLength(2);
    for(const option of options){expect(option).toMatchObject({authPath});expect((option as any).credentials).toBeUndefined();}
    expect(touched).toBe(0);expect(readFileSync(f.path,"utf8")).toBe(before);expect(getPiSupervisor(db)?.credential_source).toBe("codex_login");
  } finally {mock.mockRestore();}
});

test("core background maintenance follows saved source, checks repeatedly and stops cleanly; worker has no timer", async () => {
  const {startCodexLoginMaintenance}=await import("./codexLoginMaintenance.ts");
  const f=fixture("core",now-1000);const db=await openDatabase({stateDir:join(f.root,"state")});cleanups.push(()=>db.close());
  const config={providers:{codex:{enabled:true,env:{CODEX_HOME:f.home},cwd:f.root}}} as any;
  let scheduled:(()=>void)|undefined;let stopped=0;
  const registry={describe:()=>({state:"ready",instance:{codexCredentialHome:f.home,refreshCodexLogin:f.binding.refresh}})} as any;
  const stop=startCodexLoginMaintenance(db,config,registry,fn=>{scheduled=fn;return()=>{stopped++;};});
  await new Promise(r=>setTimeout(r,0));expect(f.calls()).toBe(0);
  updatePiSupervisor(db,{credential_source:"codex_login"});scheduled!();
  await new Promise(r=>setTimeout(r,0));expect(f.calls()).toBe(1);
  f.write(now-1000);scheduled!();await new Promise(r=>setTimeout(r,0));expect(f.calls()).toBe(2);
  stop();expect(stopped).toBe(1);
  const stopWorker=startCodexLoginMaintenance(db,config,undefined,()=>{throw new Error("worker must not schedule");});
  await new Promise(r=>setTimeout(r,0));expect(f.calls()).toBe(2);stopWorker();
});

test("every application runtime entry uses the shared factory with explicit isolated modes", () => {
  const root=join(import.meta.dir,"..");
  const files=["http/piRuntime.ts","http/piOAuthApi.ts","pi/sessionTitleGenerator.ts","xuanwu/memoryReplayRuntime.ts","spikes/piSmoke.ts"];
  for(const file of files){const text=readFileSync(join(root,file),"utf8");expect(text).toContain("createPiModelRuntime(");expect(text).not.toContain("ModelRuntime.create(");}
  expect(readFileSync(join(root,"xuanwu/memoryReplayRuntime.ts"),"utf8")).toContain('mode: "replay"');
  expect(readFileSync(join(root,"spikes/piSmoke.ts"),"utf8")).toContain('mode: "smoke"');
  expect(readFileSync(join(root,"pi/codexLoginMaintenance.ts"),"utf8")).toContain("setInterval(check, CODEX_REFRESH_INTERVAL_MS)");
});
