'use client';
// Privacy: five checks (a private balance, a backup, balances hidden on screen, the relayer up, a crowd to blend into), the
// score they add up to, good habits and who sees what. The header chip shows the same count.
import type { ReactNode } from 'react';
import { Icon, Tip } from '@/components/ui/primitives';
import type { Term } from '@/lib/glossary';
import { openBackup } from '@/features/backup/BackupDialogs';
import { useBalances } from '@/features/portfolio/balances';
import { engine, isLive, setHide, useSession } from '@/features/session/session';
import { go } from '@/features/shell/router';
import { age } from '@/lib/format';

const CROWD_MIN = 50;
export interface PrivacyChecks { notes: number; backedUpAt: number | null; hide: boolean; relayer: boolean | null; crowd: number | null; passed: number }

/// The five checks, or null when there is no engine (preview). Re-read whenever the session changes.
export function usePrivacyChecks(): PrivacyChecks | null {
  const live = useSession((s) => isLive(s)), hide = useSession((s) => s.hide), relayer = useSession((s) => s.relayer);
  useSession((s) => s.version);
  useBalances(); // note count and crowd size change when the private sync lands
  if (!live) return null;
  const E = engine();
  let notes = 0; try { notes = E.shieldNotes().length; } catch { /* not synced yet */ }
  let crowd: number | null = null; try { crowd = E.shieldState?.leaves ? E.shieldState.leaves.length : null; } catch { /* not synced yet */ }
  const backedUpAt = E.store.data.backedUpAt || null;
  const passed = [notes > 0, !!backedUpAt, hide, relayer === true, crowd != null && crowd >= CROWD_MIN].filter(Boolean).length;
  return { notes, backedUpAt, hide, relayer, crowd, passed };
}

export function PrivacyChip() {
  const c = usePrivacyChecks();
  return (
    <button className={'pvchip' + (c && c.passed >= 4 ? ' ok' : '')} id="pvChip" type="button" title="Your privacy" aria-label={'Privacy' + (c ? `: ${c.passed} of 5 checks pass` : '')} onClick={() => go('privacy')}>
      <Icon name="shield" size="sm" /><span className="lg">Private</span><em id="pvChipN">{c ? `${c.passed}/5` : ''}</em>
    </button>
  );
}

const CHECK_TERM: Record<string, Term> = { 'Private balance': 'privateBalance', Backup: 'backupCheck', 'Balances on screen': 'hideBalances', Relayer: 'relayerCheck', 'Crowd size': 'crowdSize' };
function Check({ title, text, good, action }: { title: string; text: ReactNode; good: boolean | null; action?: ReactNode }) {
  return (
    <div className="row">
      <span className={'ck ' + (good === true ? 'g' : good === false ? 'b' : 'n')}><Icon name={good === true ? 'check' : good === false ? 'alert' : 'clock'} size="sm" /></span>
      <div className="mid"><b>{title}{CHECK_TERM[title] && <Tip term={CHECK_TERM[title]} align="l" />}</b><small>{text}</small></div>
      {action && <div className="rt">{action}</div>}
    </div>
  );
}

const HABITS: [string, string][] = [
  ['Withdraw to a new wallet', 'Never back to the wallet you deposited from. Veyl blocks that, and any address with history.'],
  ['Give it time', 'Wait a while between depositing and withdrawing. The more people move in between, the harder you are to follow.'],
  ['Use common amounts', 'Round numbers blend in. An unusual amount in and the same amount out can be matched.'],
  ['Use sealed swaps for size', 'Big swaps go in a sealed batch: nobody sees your order or trades ahead of it.'],
  ['Back up your keys', 'Your private balance lives in this browser. An encrypted backup is the only way to recover it.'],
];
const WHO_SEES: [string, boolean][] = [
  ['Your wallet', true], ['Your position size', true], ['Fees you earned', true], ['Your sealed swap size', true], ['Pool totals and prices', false], ['Deposits into Veyl', false],
];

export default function PrivacyPage() {
  const c = usePrivacyChecks();
  const hide = useSession((s) => s.hide);
  const hideBtn = <button className="btn sm ghost" type="button" id="pvHide" onClick={() => setHide(!hide)}>{hide ? 'Show' : 'Hide'}</button>;
  const word = !c ? 'Not checked' : c.passed >= 5 ? 'Strong' : c.passed >= 3 ? 'Good' : 'Getting started';
  return (
    <section className="page" id="pg-privacy">
      <div className="ph"><div><h1>Privacy</h1><p>How private you are right now, and how to keep it that way.</p></div></div>
      <div className="pvgrid">
        <div className="col">
          <div className="card pad pvscore" id="pvScore">
            <span className="k">Your privacy<Tip term="privacyScore" align="l" /></span><b className="big">{word}</b>
            {c ? <><div className="pvbar"><i style={{ width: (c.passed / 5) * 100 + '%' }}></i></div>
              <p className="dim">{c.passed} of 5 checks pass.{c.crowd != null && <> You blend in with <b>{c.crowd.toLocaleString('en-US')}</b> private deposits.</>}</p></>
              : <p className="dim">Connect a wallet to run the checks.</p>}
          </div>
          <div className="sec"><h2>Checks</h2></div>
          <div className="list" id="pvChecks">
            {!c ? <>
              <Check title="Private balance" text="Deposit once to start using Veyl privately." good={null} />
              <Check title="Backup" text="Back up after your first deposit." good={null} />
              <Check title="Balances on screen" text={hide ? 'Hidden on this screen.' : 'Visible on this screen.'} good={hide ? true : null} action={hideBtn} />
              <Check title="Relayer" text="Sends your private actions so your wallet never signs them." good={null} />
            </> : <>
              <Check title="Private balance" text={c.notes > 0 ? `${c.notes} private note${c.notes === 1 ? '' : 's'} ready to use.` : 'Deposit once to start using Veyl privately.'} good={c.notes > 0}
                action={c.notes > 0 ? undefined : <button className="btn sm" type="button" onClick={() => go('home')}>Deposit</button>} />
              <Check title="Backup" text={c.backedUpAt ? `Backed up ${age(Date.now() - c.backedUpAt)} ago.` : 'Not backed up. Clear this browser and the balance is gone.'} good={!!c.backedUpAt}
                action={c.backedUpAt ? undefined : <button className="btn sm" type="button" onClick={openBackup}>Back up</button>} />
              <Check title="Balances on screen" text={hide ? 'Hidden on this screen.' : 'Visible to anyone looking at your screen.'} good={hide} action={hideBtn} />
              <Check title="Relayer" text={c.relayer === true ? 'Online. Your wallet never signs private actions.' : c.relayer === false ? 'Not answering. Private actions wait until it is back.' : 'Checking…'} good={c.relayer} />
              <Check title="Crowd size" good={c.crowd == null ? null : c.crowd >= CROWD_MIN}
                text={c.crowd == null ? 'Reading the private pool…' : c.crowd >= CROWD_MIN ? `${c.crowd.toLocaleString('en-US')} private deposits to blend in with.` : `Only ${c.crowd} private deposits so far. Privacy gets stronger as more people join.`} />
            </>}
          </div>
        </div>
        <div className="col">
          <div className="sec"><h2>Good habits</h2></div>
          <div className="list pvtips">
            {HABITS.map(([t, s], i) => <div key={t} className="row"><span className="pvn">{i + 1}</span><div className="mid"><b>{t}</b><small>{s}</small></div></div>)}
          </div>
          <div className="sec"><h2>Who sees what</h2></div>
          <div className="card pad pvtable">
            <div className="r h"><span></span><span>Who can see it</span></div>
            {WHO_SEES.map(([t, onlyYou]) => <div key={t} className="r"><span>{t}</span><span className={onlyYou ? 'yes' : 'no'}>{onlyYou ? 'Only you' : 'Everyone'}</span></div>)}
          </div>
        </div>
      </div>
    </section>
  );
}
