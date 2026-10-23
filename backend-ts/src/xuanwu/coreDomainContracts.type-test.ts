import {
  DOMAIN_EVENT_NAMES,
  makeDomainID,
  type DomainEventName,
  type RunID,
  type Work,
  type WorkID
} from "./coreDomainContracts.ts";

const workID = makeDomainID("work", "issues", 634);
const runID = makeDomainID("run", "issue_runs", "issue-634-attempt-1");

const typedWorkID: WorkID = workID;
const typedRunID: RunID = runID;
const firstEventName: DomainEventName = DOMAIN_EVENT_NAMES[0];

// @ts-expect-error Run ID 不能赋给 Work ID。
const wrongWorkID: WorkID = typedRunID;

// @ts-expect-error Work 合同必须携带 owner 与 acceptance criteria。
const incompleteWork: Work = { id: typedWorkID, status: "triage" };

void firstEventName;
void incompleteWork;
void wrongWorkID;
