// Every endpoint, once: its types (Endpoints) and its method, path and access rule
// (ROUTES). The Worker routes with matchRoute, and clients and mocks are typed by
// Endpoints, so the two cannot drift: ROUTES must name every key of Endpoints.
//
// Access: "public" needs nothing; "session" a signed-in browser user; "agent" a
// machine's agent token; "system" the operators only. `scope` says which object the
// role is checked against, and `minRole` the least role there. Finer rules (a member
// sees only their own machines) are the handler's job and are noted in `note`.

import type { Micros } from "./money.ts";
import type { MachineId, MemberId, OrgId, ProjectId, TeamId } from "./ids.ts";
import type { IsoTime } from "./time.ts";
import type { OrgRole, ProjectRole } from "./objects.ts";
import type {
  AgentAbortRequest,
  AgentEnrollRequest,
  AgentEnrollResponse,
  AgentHeartbeatRequest,
  AgentHeartbeatResponse,
  AgentSaveStatusRequest,
  AgentWorkspaceTokenResponse,
  Allocation,
  LedgerEntry,
  Machine,
  MachineSession,
  Me,
  Member,
  Organization,
  PriceListItem,
  Project,
  ProjectLabels,
  ProjectPolicy,
  Quote,
  QuoteRequest,
  SpendCsvGrouping,
  SpendMeter,
  StartMachineRequest,
  StopMachineRequest,
  Team,
} from "./objects.ts";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** A page of results; pass `next` back as `cursor` for the next page, until it is null. */
export interface Page<T> {
  items: T[];
  next: string | null;
}

export interface Ok {
  ok: true;
}

// Request bodies that are not objects of their own.
export interface CreateProjectRequest {
  name: string;
  startsAt: IsoTime;
  endsAt: IsoTime;
  budget: Micros;
  labels?: ProjectLabels | null;
  policy?: Partial<ProjectPolicy>;
}
export interface UpdateProjectRequest {
  name?: string;
  startsAt?: IsoTime;
  endsAt?: IsoTime;
  labels?: ProjectLabels | null;
  policy?: Partial<ProjectPolicy>;
}
export interface InviteMembersRequest {
  members: Array<{ email: string; name?: string; role?: ProjectRole; teamId?: TeamId; allocation?: Micros }>;
}
export interface UpdateMemberRequest {
  name?: string;
  role?: ProjectRole;
  teamId?: TeamId | null;
}
export interface CreateTeamRequest {
  name: string;
  memberIds?: MemberId[];
  allocation?: Micros;
}
export interface UpdateTeamRequest {
  name?: string;
  memberIds?: MemberId[];
}
export interface SetAllocationRequest {
  amount: Micros;
}
/** Move credit between the organization and a project; negative returns it to the org. */
export interface MoveBudgetRequest {
  amount: Micros;
}
export interface AddCreditRequest {
  amount: Micros;
  /** An invoice or purchase-order reference. */
  reference: string;
}

/** A 302 the browser follows: these routes are navigated to, never fetched by a client. */
export type Redirect = never;

/** Path parameters are named `:name` in ROUTES and appear here with the same names. */
export interface Endpoints {
  // auth
  // (sign-in goes through WorkOS AuthKit: the browser navigates to startSignIn, never fetches it; see signin.ts)
  startSignIn: { method: "GET"; path: "/v1/auth/start"; params: {}; query: { return?: string }; body: undefined; response: Redirect };
  signInCallback: { method: "GET"; path: "/v1/auth/callback"; params: {}; query: { code?: string; state?: string; error?: string }; body: undefined; response: Redirect };
  signOut: { method: "POST"; path: "/v1/auth/sign-out"; params: {}; query: {}; body: {}; response: Ok };
  getMe: { method: "GET"; path: "/v1/me"; params: {}; query: {}; body: undefined; response: Me };

  // organizations
  getOrg: { method: "GET"; path: "/v1/orgs/:orgId"; params: { orgId: OrgId }; query: {}; body: undefined; response: Organization };
  addOrgCredit: { method: "POST"; path: "/v1/orgs/:orgId/credit"; params: { orgId: OrgId }; query: {}; body: AddCreditRequest; response: Organization };
  listProjects: { method: "GET"; path: "/v1/orgs/:orgId/projects"; params: { orgId: OrgId }; query: { cursor?: string }; body: undefined; response: Page<Project> };
  createProject: { method: "POST"; path: "/v1/orgs/:orgId/projects"; params: { orgId: OrgId }; query: {}; body: CreateProjectRequest; response: Project };

  // projects
  getProject: { method: "GET"; path: "/v1/projects/:projectId"; params: { projectId: ProjectId }; query: {}; body: undefined; response: Project };
  updateProject: { method: "PATCH"; path: "/v1/projects/:projectId"; params: { projectId: ProjectId }; query: {}; body: UpdateProjectRequest; response: Project };
  moveProjectBudget: { method: "POST"; path: "/v1/projects/:projectId/budget"; params: { projectId: ProjectId }; query: {}; body: MoveBudgetRequest; response: Project };

  // members and teams
  listMembers: { method: "GET"; path: "/v1/projects/:projectId/members"; params: { projectId: ProjectId }; query: { cursor?: string; teamId?: TeamId }; body: undefined; response: Page<Member> };
  inviteMembers: { method: "POST"; path: "/v1/projects/:projectId/members"; params: { projectId: ProjectId }; query: {}; body: InviteMembersRequest; response: { members: Member[] } };
  updateMember: { method: "PATCH"; path: "/v1/projects/:projectId/members/:memberId"; params: { projectId: ProjectId; memberId: MemberId }; query: {}; body: UpdateMemberRequest; response: Member };
  removeMember: { method: "DELETE"; path: "/v1/projects/:projectId/members/:memberId"; params: { projectId: ProjectId; memberId: MemberId }; query: {}; body: undefined; response: Ok };
  setMemberAllocation: { method: "PUT"; path: "/v1/projects/:projectId/members/:memberId/allocation"; params: { projectId: ProjectId; memberId: MemberId }; query: {}; body: SetAllocationRequest; response: Allocation };
  listTeams: { method: "GET"; path: "/v1/projects/:projectId/teams"; params: { projectId: ProjectId }; query: {}; body: undefined; response: { teams: Team[] } };
  createTeam: { method: "POST"; path: "/v1/projects/:projectId/teams"; params: { projectId: ProjectId }; query: {}; body: CreateTeamRequest; response: Team };
  updateTeam: { method: "PATCH"; path: "/v1/projects/:projectId/teams/:teamId"; params: { projectId: ProjectId; teamId: TeamId }; query: {}; body: UpdateTeamRequest; response: Team };
  deleteTeam: { method: "DELETE"; path: "/v1/projects/:projectId/teams/:teamId"; params: { projectId: ProjectId; teamId: TeamId }; query: {}; body: undefined; response: Ok };
  setTeamAllocation: { method: "PUT"; path: "/v1/projects/:projectId/teams/:teamId/allocation"; params: { projectId: ProjectId; teamId: TeamId }; query: {}; body: SetAllocationRequest; response: Allocation };

  // prices and spend
  listGpuTypes: { method: "GET"; path: "/v1/projects/:projectId/gpu-types"; params: { projectId: ProjectId }; query: {}; body: undefined; response: { items: PriceListItem[]; asOf: IsoTime } };
  quote: { method: "POST"; path: "/v1/projects/:projectId/quote"; params: { projectId: ProjectId }; query: {}; body: QuoteRequest; response: Quote };
  getSpend: { method: "GET"; path: "/v1/projects/:projectId/spend"; params: { projectId: ProjectId }; query: {}; body: undefined; response: { meters: SpendMeter[]; asOf: IsoTime } };
  getSpendCsv: { method: "GET"; path: "/v1/projects/:projectId/spend.csv"; params: { projectId: ProjectId }; query: { by: SpendCsvGrouping }; body: undefined; response: string };
  listLedger: { method: "GET"; path: "/v1/projects/:projectId/ledger"; params: { projectId: ProjectId }; query: { cursor?: string }; body: undefined; response: Page<LedgerEntry> };

  // machines
  listMachines: { method: "GET"; path: "/v1/projects/:projectId/machines"; params: { projectId: ProjectId }; query: { cursor?: string; all?: "1" }; body: undefined; response: Page<Machine> };
  startMachine: { method: "POST"; path: "/v1/projects/:projectId/machines"; params: { projectId: ProjectId }; query: {}; body: StartMachineRequest; response: Machine };
  stopAllMachines: { method: "POST"; path: "/v1/projects/:projectId/stop-all"; params: { projectId: ProjectId }; query: {}; body: StopMachineRequest; response: { stopping: MachineId[] } };
  getMachine: { method: "GET"; path: "/v1/machines/:machineId"; params: { machineId: MachineId }; query: {}; body: undefined; response: Machine };
  stopMachine: { method: "POST"; path: "/v1/machines/:machineId/stop"; params: { machineId: MachineId }; query: {}; body: StopMachineRequest; response: Machine };
  restartMachine: { method: "POST"; path: "/v1/machines/:machineId/start"; params: { machineId: MachineId }; query: {}; body: {}; response: Machine };
  saveMachine: { method: "POST"; path: "/v1/machines/:machineId/save"; params: { machineId: MachineId }; query: {}; body: {}; response: Machine };
  deleteMachine: { method: "DELETE"; path: "/v1/machines/:machineId"; params: { machineId: MachineId }; query: {}; body: undefined; response: Ok };
  openMachineSession: { method: "POST"; path: "/v1/machines/:machineId/session"; params: { machineId: MachineId }; query: {}; body: {}; response: MachineSession };
  openJupyterLink: { method: "POST"; path: "/v1/machines/:machineId/jupyter-link"; params: { machineId: MachineId }; query: {}; body: {}; response: { url: string; expiresAt: IsoTime } };

  // agent (on the machine)
  agentEnroll: { method: "POST"; path: "/v1/agent/enroll"; params: {}; query: {}; body: AgentEnrollRequest; response: AgentEnrollResponse };
  agentHeartbeat: { method: "POST"; path: "/v1/agent/heartbeat"; params: {}; query: {}; body: AgentHeartbeatRequest; response: AgentHeartbeatResponse };
  agentWorkspaceToken: { method: "POST"; path: "/v1/agent/workspace-token"; params: {}; query: {}; body: { incarnation: number }; response: AgentWorkspaceTokenResponse };
  agentSaveStatus: { method: "POST"; path: "/v1/agent/save-status"; params: {}; query: {}; body: AgentSaveStatusRequest; response: Ok };
  agentAbort: { method: "POST"; path: "/v1/agent/abort"; params: {}; query: {}; body: AgentAbortRequest; response: {} };
}

export type EndpointName = keyof Endpoints;

export type RouteAuth = "public" | "session" | "agent" | "system";

export type RouteAccess =
  | { auth: "public" }
  | { auth: "system" }
  | { auth: "agent" }
  | { auth: "session"; scope: "none" }
  | { auth: "session"; scope: "org"; minRole: OrgRole }
  | { auth: "session"; scope: "project" | "machine"; minRole: ProjectRole };

export type RouteSpec<E extends { method: HttpMethod; path: string }> = {
  method: E["method"];
  path: E["path"];
  access: RouteAccess;
  note?: string;
};

const member = { auth: "session", scope: "project", minRole: "member" } as const;
const assistant = { auth: "session", scope: "project", minRole: "assistant" } as const;
const manager = { auth: "session", scope: "project", minRole: "manager" } as const;
const machineMember = { auth: "session", scope: "machine", minRole: "member" } as const;
const OWN = "a member may act only on their own machines; assistants and above on any in the project";

export const ROUTES: { readonly [K in EndpointName]: RouteSpec<Endpoints[K]> } = {
  startSignIn: { method: "GET", path: "/v1/auth/start", access: { auth: "public" }, note: "a 302 to WorkOS AuthKit; `return` is kept only if isSafeReturnPath" },
  signInCallback: { method: "GET", path: "/v1/auth/callback", access: { auth: "public" }, note: "WorkOS's redirect back: a 302 to the return path with the session cookie, or to /?signin=<SignInOutcome>" },
  signOut: { method: "POST", path: "/v1/auth/sign-out", access: { auth: "session", scope: "none" } },
  getMe: { method: "GET", path: "/v1/me", access: { auth: "session", scope: "none" } },

  getOrg: { method: "GET", path: "/v1/orgs/:orgId", access: { auth: "session", scope: "org", minRole: "viewer" } },
  addOrgCredit: { method: "POST", path: "/v1/orgs/:orgId/credit", access: { auth: "system" }, note: "manual top-up against an invoice or PO" },
  listProjects: { method: "GET", path: "/v1/orgs/:orgId/projects", access: { auth: "session", scope: "org", minRole: "viewer" } },
  createProject: { method: "POST", path: "/v1/orgs/:orgId/projects", access: { auth: "session", scope: "org", minRole: "owner" } },

  getProject: { method: "GET", path: "/v1/projects/:projectId", access: member },
  updateProject: { method: "PATCH", path: "/v1/projects/:projectId", access: manager },
  moveProjectBudget: { method: "POST", path: "/v1/projects/:projectId/budget", access: { auth: "session", scope: "project", minRole: "owner" }, note: "the project owner must also be an org owner" },

  listMembers: { method: "GET", path: "/v1/projects/:projectId/members", access: assistant },
  inviteMembers: { method: "POST", path: "/v1/projects/:projectId/members", access: manager, note: "authz.canInvite for each row" },
  updateMember: { method: "PATCH", path: "/v1/projects/:projectId/members/:memberId", access: manager, note: "authz.canUpdateMember" },
  removeMember: { method: "DELETE", path: "/v1/projects/:projectId/members/:memberId", access: manager, note: "authz.canRemoveMember" },
  setMemberAllocation: { method: "PUT", path: "/v1/projects/:projectId/members/:memberId/allocation", access: manager },
  listTeams: { method: "GET", path: "/v1/projects/:projectId/teams", access: member, note: "members see their own team only" },
  createTeam: { method: "POST", path: "/v1/projects/:projectId/teams", access: manager },
  updateTeam: { method: "PATCH", path: "/v1/projects/:projectId/teams/:teamId", access: manager },
  deleteTeam: { method: "DELETE", path: "/v1/projects/:projectId/teams/:teamId", access: manager },
  setTeamAllocation: { method: "PUT", path: "/v1/projects/:projectId/teams/:teamId/allocation", access: manager },

  listGpuTypes: { method: "GET", path: "/v1/projects/:projectId/gpu-types", access: member },
  quote: { method: "POST", path: "/v1/projects/:projectId/quote", access: member },
  getSpend: { method: "GET", path: "/v1/projects/:projectId/spend", access: member, note: "members see their own and their team's meters only" },
  getSpendCsv: { method: "GET", path: "/v1/projects/:projectId/spend.csv", access: assistant },
  listLedger: { method: "GET", path: "/v1/projects/:projectId/ledger", access: manager },

  listMachines: { method: "GET", path: "/v1/projects/:projectId/machines", access: member, note: "all=1 needs assistant; otherwise the caller's own" },
  startMachine: { method: "POST", path: "/v1/projects/:projectId/machines", access: member },
  stopAllMachines: { method: "POST", path: "/v1/projects/:projectId/stop-all", access: assistant, note: "save=false needs manager" },
  getMachine: { method: "GET", path: "/v1/machines/:machineId", access: machineMember, note: OWN },
  stopMachine: { method: "POST", path: "/v1/machines/:machineId/stop", access: machineMember, note: `${OWN}; save=false needs manager` },
  restartMachine: { method: "POST", path: "/v1/machines/:machineId/start", access: machineMember, note: OWN },
  saveMachine: { method: "POST", path: "/v1/machines/:machineId/save", access: machineMember, note: OWN },
  deleteMachine: { method: "DELETE", path: "/v1/machines/:machineId", access: machineMember, note: OWN },
  openMachineSession: { method: "POST", path: "/v1/machines/:machineId/session", access: machineMember, note: "the machine's own member only" },
  openJupyterLink: { method: "POST", path: "/v1/machines/:machineId/jupyter-link", access: machineMember, note: "the machine's own member only" },

  agentEnroll: { method: "POST", path: "/v1/agent/enroll", access: { auth: "public" }, note: "authenticated by the boot token in the body (bootExchange); a second use is refused (tokenReused), alerted and terminates the machine" },
  agentHeartbeat: { method: "POST", path: "/v1/agent/heartbeat", access: { auth: "agent" } },
  agentWorkspaceToken: { method: "POST", path: "/v1/agent/workspace-token", access: { auth: "agent" } },
  agentSaveStatus: { method: "POST", path: "/v1/agent/save-status", access: { auth: "agent" } },
  agentAbort: { method: "POST", path: "/v1/agent/abort", access: { auth: "public" }, note: "authenticated by the boot token in the body; uses it up and terminates the machine" },
};

export interface RouteMatch {
  name: EndpointName;
  params: Record<string, string>;
}

/** Path segments may hold only these characters; anything else never matches. */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * The endpoint for a method and a path (without query string), and its path
 * parameters; null when none matches. Literal segments must match exactly.
 */
export function matchRoute(method: string, path: string): RouteMatch | null {
  const parts = path.split("/");
  for (const name of Object.keys(ROUTES) as EndpointName[]) {
    const spec = ROUTES[name];
    if (spec.method !== method) continue;
    const pattern = spec.path.split("/");
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pattern.length; i++) {
      const p = pattern[i] as string;
      const s = parts[i] as string;
      if (p.startsWith(":")) {
        if (!SEGMENT.test(s)) {
          ok = false;
          break;
        }
        params[p.slice(1)] = s;
      } else if (p !== s) {
        ok = false;
        break;
      }
    }
    if (ok) return { name, params };
  }
  return null;
}

/** Fill a route's path parameters, for clients. Each value must be a valid segment. */
export function buildPath(name: EndpointName, params: Record<string, string>): string {
  return ROUTES[name].path
    .split("/")
    .map((p) => {
      if (!p.startsWith(":")) return p;
      const v = params[p.slice(1)];
      if (v === undefined || !SEGMENT.test(v)) throw new RangeError(`bad or missing path parameter ${p} for ${name}`);
      return v;
    })
    .join("/");
}
