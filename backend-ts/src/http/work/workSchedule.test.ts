import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { getIssueAsWork, issueIDToWorkID, listIssueBackedWorks } from "../../domain/work/issueAdapter.ts";
import { insertWorkRecord, insertWorkRelationRecord } from "../../db/repositories/workLedger.ts";
import { readProjectIssueDependencies } from "../../domain/work/issueDependency.ts";
import { declareIssueReadinessRequirements } from "../../domain/readiness/contracts.ts";
import { recordWorkspaceWait } from "../../db/repositories/workspaceWaits.ts";
import { projectLoopDecision } from "../../runner/projectLoop.ts";
import { readProjectLoopSnapshot, setProjectLoopMaxParallelProjects, startProjectLoop, kickAutoRunProjects } from "../../runner/projectLoopManager.ts";
import { projectCapacityAvailable } from "../../runner/queueEligibility.ts";
import { createRouter } from "../router.ts";
import { registerWorkRoutes } from "./workApi.ts";
import { registerCommandCenterRoutes } from "./commandCenterApi.ts";
import { attachWorkSchedules } from "./workSchedule.ts";
import type { ExecutorProvider } from "../../providers/types.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { while(cleanup.length) cleanup.pop()!(); setProjectLoopMaxParallelProjects(1); });
const NOW = "2026-10-15T12:00:00Z";
async function fixture() {
  const root = mkdtempSync("/tmp/xw-schedule-");
  const db = await openDatabase({ stateDir: root });
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  let checks = 0;
  const provider = { id: "codex", capabilities: ["issue_execution"], runtimeStatus: () => { checks++; return { ready: true }; },
    run: async () => { throw new Error("fixture must not execute"); } } as unknown as ExecutorProvider;
  const context = { database: db, providers: { codex: provider } };
  const project = (id="demo", cwd=join(root,id), auto=1) => db.sqlite.run(
    "insert into projects(id,name,cwd,provider,auto_run,created_at,updated_at) values(?,?,?,?,?,?,?)", [id,id,cwd,"codex",auto,NOW,NOW]);
  project();
  const issue = (status="todo", p="demo", priority=0) => createIssue(db,{project_id:p,status,title:`Fixture ${p} ${status}`,priority});
  const schedule = (id:number) => attachWorkSchedules(context,[getIssueAsWork(db,id)!])[0].schedule;
  const decide = (p="demo", force=false) => projectLoopDecision({...context,projectId:p,now:NOW},force);
  const router=createRouter();registerWorkRoutes(router,context);registerCommandCenterRoutes(router,context,{now:()=>new Date(NOW)});
  const get=async(path:string)=>{const response=await router.handle(new Request(`http://fixture${path}`));expect(response.status).toBe(200);return response.json() as Promise<any>;};
  return {root,db,context,provider,project,issue,schedule,decide,get,checks:()=>checks};
}
function edge(db:RunnerDatabase, from:number, to:number, project="demo") {
  for(const id of [from,to]) if(!db.sqlite.query("select id from works where id=?").get(issueIDToWorkID(id))) insertWorkRecord(db,getIssueAsWork(db,id)!);
  insertWorkRelationRecord(db,project,{actor:{id:"fixture",kind:"runner"},audit_event_ref:`edge:${from}:${to}`,correlation_id:`edge:${from}:${to}`,depends_on_work_id:issueIDToWorkID(to),kind:"depends_on",occurred_at:NOW,reason:"fixture dependency",relation_id:`edge:${from}:${to}`,work_id:issueIDToWorkID(from)});
}
function readiness(db:RunnerDatabase, id:number, source:number) {
  declareIssueReadinessRequirements(db,id,{audit:{actor:{id:"fixture",kind:"system"},correlation_id:`r:${id}`,event_id:`r:${id}`,occurred_at:NOW,reason:"fixture gate"},requirements:[{environment:"production",release_window:"fixture",required_stage:"observed",runtime_revision:"fixture-runtime",source_revision:"fixture-source",source_work_id:issueIDToWorkID(source)}],schema_version:1,work_id:issueIDToWorkID(id)});
}
const codes = (schedule:ReturnType<typeof attachWorkSchedules>[number]["schedule"]) => schedule?.reasons.map(reason=>reason.code);

test("only todo projects schedule; future retry metadata does not invent a queue gate", async()=>{
  const f=await fixture();
  for(const status of ["triage","in_progress","needs_user","done","failed","cancelled"]) expect(f.schedule(f.issue(status).id)).toBeUndefined();
  // Remove unrelated occupancy from the first status assertions.
  f.db.sqlite.run("update issues set status='done'");
  const item=f.issue();f.db.sqlite.run("update issues set auto_retry_next_at=? where id=?",["2099-01-01T00:00:00Z",item.id]);
  expect(f.schedule(item.id)).toEqual({state:"runnable",reasons:[]});expect(f.decide().reason).toBe("ready");
});

test("candidate diagnostics preserve old project enum while ordering project gates before provider",async()=>{
  const f=await fixture();const item=f.issue();f.db.sqlite.run("update projects set auto_run=0");
  f.db.sqlite.run("insert into project_holds(project_id,reason,message,hold_since,updated_at) values(?,?,?,?,?)",["demo","fixture","fixture",NOW,NOW]);
  f.context.providers={};
  expect(codes(f.schedule(item.id))).toEqual(["project_hold","auto_run_off","provider_unavailable"]);
  expect(f.decide().reason).toBe("project_hold");
  f.db.sqlite.run("delete from project_holds");expect(f.decide().reason).toBe("user_pause");expect(codes(f.schedule(item.id))?.[0]).toBe("auto_run_off");
});

for(const [sourceStatus,reason] of [["todo","dependency_waiting"],["failed","dependency_failed"]] as const) test(`maps ${reason} and links the same root blocker`,async()=>{
  const f=await fixture();const source=f.issue(sourceStatus);const child=f.issue("todo","demo",10);edge(f.db,child.id,source.id);
  const projected=f.schedule(child.id)!;expect(projected.reasons[0]).toMatchObject({code:reason,detail:{root_blockers:[{work_id:issueIDToWorkID(source.id),status:sourceStatus}]}});
  expect(readProjectIssueDependencies(f.db,"demo").get(child.id)?.ready).toBe(false);
});

test("missing edges, cycles, readiness and workspace waits retain distinct diagnostics",async()=>{
  const f=await fixture();const missing=f.issue();f.db.sqlite.run("update issues set dependency_issue_ids_json='[999999]' where id=?",[missing.id]);
  expect(codes(f.schedule(missing.id))?.[0]).toBe("dependency_missing");
  const a=f.issue(),b=f.issue();edge(f.db,a.id,b.id);edge(f.db,b.id,a.id);expect(codes(f.schedule(a.id))?.[0]).toBe("dependency_cycle");
  const source=f.issue("done"),child=f.issue();edge(f.db,child.id,source.id);readiness(f.db,child.id,source.id);
  expect(codes(f.schedule(child.id))?.[0]).toBe("readiness_waiting");
  const wait=f.issue();recordWorkspaceWait(f.db,wait.id,{state:"released",request_id:"request",revision:1,run_id:"fixture-run",input:"fixture-input",workspace:{cwd:join(f.root,"demo"),head:"head",branch:"branch"}});
  expect(codes(f.schedule(wait.id))?.[0]).toBe("workspace_waiting");
});

test("physical head can be blocked while the selected later ID is runnable",async()=>{
  const f=await fixture();const source=f.issue("failed"),head=f.issue("todo","demo",10),tail=f.issue();edge(f.db,head.id,source.id);
  const decision=f.decide();expect(decision.issue?.id).toBe(tail.id);expect(decision.reason).toBe("ready");
  expect(f.schedule(decision.issue!.id)?.state).toBe("runnable");expect(codes(f.schedule(head.id))).toEqual(["dependency_failed"]);
  f.db.sqlite.run("update issues set status='done' where id=?",[tail.id]);expect(f.decide().reason).toBe("dependency_blocker");
  expect(codes(f.schedule(f.decide().issue!.id))?.[0]).toBe("dependency_failed");
});

test("provider unavailable uses the same readiness gate without requiring an optional runtimeStatus",async()=>{
  const f=await fixture();const item=f.issue();
  f.provider.runtimeStatus=()=>({ready:false,reason:"not_authenticated"} as any);
  expect(f.schedule(item.id)?.reasons[0]).toMatchObject({code:"provider_unavailable",detail:{provider_id:"codex",category:"runtime_not_ready",reason:"not_authenticated"}});
  expect(f.decide().reason).toBe("provider_runtime");
  f.provider.runtimeStatus=undefined;expect(f.schedule(item.id)?.state).toBe("runnable");expect(f.decide().reason).toBe("ready");
  const context={...f.context,providersRegistry:{readyProviders:()=>({})} as any};
  expect(attachWorkSchedules(context,[getIssueAsWork(f.db,item.id)!])[0].schedule?.state).toBe("runnable");
});

test("shared canonical directory, needs_user occupancy, and global open-run capacity use existing gates",async()=>{
  const f=await fixture();mkdirSync(join(f.root,"shared"));symlinkSync(join(f.root,"shared"),join(f.root,"alias"));
  f.project("a",join(f.root,"shared"));f.project("b",join(f.root,"alias"));const active=f.issue("needs_user","a"),queued=f.issue("todo","b");
  expect(codes(f.schedule(queued.id))).toEqual(["project_busy"]);
  expect(f.schedule(queued.id)?.reasons[0].detail).toEqual({scope:"workspace",holder:"awaiting_user",holder_work_ids:[issueIDToWorkID(active.id)]});
  f.db.sqlite.run("insert into issue_runs(id,issue_id,attempt,status,started_at) values(?,?,?,?,?)",["fixture-run",active.id,1,"in_progress",NOW]);
  expect(codes(f.schedule(queued.id))).toEqual(["project_busy","capacity_full"]);
  expect(f.schedule(queued.id)?.reasons[0].detail).toEqual({scope:"workspace",holder:"running"});
  const own=f.issue();expect(f.schedule(own.id)?.reasons[0]).toMatchObject({code:"capacity_full",detail:{source:"core_runtime",open_runs:1,workers:0,maximum:1}});
  expect(projectCapacityAvailable(0,1,1)).toBe(false);expect(projectCapacityAvailable(1,0,1)).toBe(false);expect(projectCapacityAvailable(0,0,1)).toBe(true);
});

test("same-process snapshot is read-only and honors a queued forced run on the writer identity",async()=>{
  const f=await fixture();f.db.sqlite.run("update projects set auto_run=0");const item=f.issue();
  // Occupy the global DB slot so registering a forced project cannot execute anything.
  f.project("busy");const active=f.issue("in_progress","busy");f.db.sqlite.run("insert into issue_runs(id,issue_id,attempt,status,started_at) values(?,?,?,?,?)",["busy",active.id,1,"in_progress",NOW]);
  startProjectLoop(f.context,"demo",{forceOnce:true});
  cleanup.push(()=>{ f.db.sqlite.run("update issues set status='done'");
    f.db.sqlite.run("update issue_runs set ended_at=?",[NOW]); kickAutoRunProjects(f.context); });
  const reader=await openDatabase({readonlyImportPath:f.db.path});cleanup.push(()=>reader.close());
  const context={...f.context,readDatabase:reader};const before=readProjectLoopSnapshot(f.db);
  const projected=attachWorkSchedules(context,[getIssueAsWork(reader,item.id)!])[0];
  expect(codes(projected.schedule)).toEqual(["capacity_full"]);expect(f.decide("demo",true).reason).toBe("ready");
  const snapshot=readProjectLoopSnapshot(f.db);snapshot.forcedProjects.clear();
  expect(readProjectLoopSnapshot(f.db)).toEqual(before);
});

test("list, board, detail and active_work share a query-only projection; attention stays unchanged",async()=>{
  const f=await fixture();const item=f.issue();f.db.sqlite.run("update projects set auto_run=0");
  const attention=await f.get("/api/command-center/summary?sections=attention");
  const before=f.db.sqlite.query("select total_changes() as n").get();f.db.sqlite.run("pragma query_only=on");
  const list=await f.get("/api/works?status=todo"),board=await f.get("/api/works/board?status=todo");
  const detail=await f.get(`/api/works/${issueIDToWorkID(item.id)}`),home=await f.get("/api/command-center/summary?sections=active_work");
  expect(list.items[0].schedule).toEqual(board.lanes.todo.items[0].schedule);
  expect(detail.work.schedule).toEqual(list.items[0].schedule);expect(home.sections.active_work.items[0].schedule).toEqual(list.items[0].schedule);
  expect(await f.get("/api/command-center/summary?sections=attention")).toEqual(attention);
  expect(f.db.sqlite.query("select total_changes() as n").get()).toEqual(before);
});

test("per request dependency graph and profiles are read once per project, provider readiness once",async()=>{
  const f=await fixture();for(let i=0;i<12;i++)f.issue();
  f.project("second");for(let i=0;i<4;i++)f.issue("todo","second");
  const works=listIssueBackedWorks(f.db);let graphReads=0,profileReads=0;
  const sqlite=new Proxy(f.db.sqlite,{get(target,key){if(key==="query")return (sql:string)=>{
    if(sql.includes("dependency_declaration_error from issues where project_id"))graphReads++;
    if(/from agent_profiles\b/.test(sql))profileReads++;
    return target.query(sql);
  };const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;}});
  const checks=f.checks();attachWorkSchedules({...f.context,readDatabase:{...f.db,sqlite}},works);
  expect(graphReads).toBe(2);expect(profileReads).toBe(1);expect(f.checks()-checks).toBe(1);
});


test("200 queued chain nodes with readiness remain within a broad projection regression ceiling",async()=>{
  const f=await fixture();let previous=f.issue("done").id;
  for(let i=0;i<200;i++){const item=f.issue();edge(f.db,item.id,previous);readiness(f.db,item.id,previous);previous=item.id;}
  const works=listIssueBackedWorks(f.db,{projectId:"demo",statuses:["todo"],limit:100});
  f.db.sqlite.run("pragma query_only=on");
  const times:number[]=[];
  for(let i=0;i<5;i++){const start=performance.now();const result=attachWorkSchedules(f.context,works);times.push(performance.now()-start);expect(result).toHaveLength(100);expect(result.every(w=>w.schedule?.state==="waiting")).toBe(true);}
  // The measured HTTP incremental budget is 100 ms; this loose CI limit only guards order-of-magnitude regressions.
  expect(times.sort((a,b)=>a-b)[2]).toBeLessThan(500);
});
