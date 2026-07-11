import { godName } from '../lib';

interface Props {
  /** canonical mode folder names, e.g. ['developer'] — empty = general */
  active: string[];
}

/**
 * Every god mode the embedded layer ships, with its trigger and one-line
 * mandate. Descriptions are distilled from the vendored mode contracts
 * (backend/godclaude-assets/modes/<id>/contract.md) — keep them in sync.
 */
// Exported for kami-sync.test.ts, which guards this list against the vendored contracts.
export const CATALOG: { id: string; trigger: string; desc: string }[] = [
  {
    id: 'general',
    trigger: 'base layer',
    desc: 'The base deterministic contract every mode specializes: decide before acting, evidence or flag, re-audit before declaring done, fail closed.',
  },
  {
    id: 'developer',
    trigger: '/goddev',
    desc: 'Merged dev + debugger + ui-ux mode. Proof = it built AND the changed path ran: red→green repro for bugs, a rendered capture for UI — a re-read never clears.',
  },
  {
    id: 'researcher',
    trigger: '/godscout',
    desc: 'Gathers external facts and synthesizes with citations. Proof = a live web search/fetch ran this turn and every fast-moving claim carries a cited source.',
  },
  {
    id: 'data-analyst',
    trigger: '/goddata',
    desc: 'Queries, transforms, and draws conclusions from data. States the grain and population first; proof = the query/computation actually ran and printed its result.',
  },
  {
    id: 'qa',
    trigger: '/godqa',
    desc: 'Tests against spec with a stated pass-condition — a test with no oracle is not a test. Proof = the test RUN output (pass/fail/skip counts), never the test code.',
  },
  {
    id: 'reviewer',
    trigger: '/godreview',
    desc: 'Adversarial review: assumes there ARE bugs until it has looked. Every finding verified by repro/diff/lint before reporting; "LGTM" needs a real inspection behind it.',
  },
  {
    id: 'planner',
    trigger: '/godplan',
    desc: 'Grounds plans in the actual codebase — real files, interfaces, constraints — with trade-offs, risks, and ordered verifiable steps. Designs; never slides into building.',
  },
  {
    id: 'ci-cd',
    trigger: '/godship',
    desc: 'Pipelines, builds, and deploys. Names the target environment before any mutation; validate/lint/plan is NOT deployed — proof = a run/apply observed green.',
  },
  {
    id: 'web-builder',
    trigger: '/godsite',
    desc: 'Builds a multi-page website from a request and polishes it to deployment-ready with its own isolated skills. Opt-in only — it never auto-activates.',
  },
];

/** Full-width row: the whole kami roster, with the live mode(s) lit. */
export function ModeCatalog({ active }: Props) {
  const activeSet = new Set(active.length ? active : ['general']);

  return (
    <section className="argus-panel">
      <div className="argus-panel-head">
        <h3>Modes</h3>
        <span className="argus-panel-sub">the Yaoyorozu no Kami — every contract the embedded layer can run under</span>
      </div>
      <div className="argus-modes-grid">
        {CATALOG.map((m) => (
          <div key={m.id} className={`argus-mode-card ${activeSet.has(m.id) ? 'active' : ''}`}>
            <div className="argus-mode-head">
              <span className="argus-mode-id argus-mono">{m.id}</span>
              <span className="argus-god">{godName(m.id)}</span>
              <span className="argus-mode-trigger argus-mono">{m.trigger}</span>
              {activeSet.has(m.id) && <span className="argus-badge argus-badge-live">ACTIVE</span>}
            </div>
            <p className="argus-mode-desc">{m.desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
