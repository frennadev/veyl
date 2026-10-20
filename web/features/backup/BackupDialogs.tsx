'use client';
// Encrypted backup (PBKDF2 + AES-256-GCM in the engine) and restore. These finish without a transaction, so they show the
// done screen themselves instead of going through runAction.
import { useState } from 'react';
import { Field, ErrorLine, Tip } from '@/components/ui/primitives';
import { openModal, toast } from '@/components/overlay';
import { showDone } from '@/features/actions/runAction';
import { engine, invalidate, session } from '@/features/session/session';

export const openBackup = () => openModal(<BackupDialog />);
/// Backup, then straight on to `next` (the deposit it was asked for) instead of the done screen.
export const openBackupThen = (next: () => void) => openModal(<BackupDialog next={next} />);
export const openRestore = () => openModal(<RestoreDialog />);

function download(text: string, name: string) {
  const u = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 4000);
}

/// A button that shows `busyLabel` while its async work runs and reports a thrown error.
function useSubmit(work: () => Promise<void>) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const run = async () => { setError(''); setBusy(true); try { await work(); } catch (e) { setError((e as Error).message); setBusy(false); } };
  return { busy, error, setError, run };
}

function BackupDialog({ next }: { next?: () => void }) {
  const [p1, setP1] = useState(''), [p2, setP2] = useState('');
  const s = useSubmit(async () => {
    const E = engine(); download(await E.exportEncrypted(p1), 'veyl-backup-' + new Date().toISOString().slice(0, 10) + '.json');
    E.markBackedUp(); invalidate();
    if (next) { toast('Backup saved. Keep the file and the passphrase in different places.', 'check', 6000); next(); return; }
    showDone({ title: 'Backup saved', body: 'Keep the file and the passphrase in different places. Anyone who has both can spend your private balance.' });
  });
  const submit = () => {
    if (p1.length < 8) return s.setError('Use at least 8 characters.');
    if (p1 !== p2) return s.setError('The two passphrases don’t match.');
    s.run();
  };
  return (
    <>
      <h3 id="dlgTitle">Back up your account</h3>
      <p>One file that brings back your private balance and positions on any device. It&apos;s locked with a passphrase you choose, here in your browser, before it&apos;s saved.</p>
      <Field id="bkP1" label={<>Passphrase<Tip term="passphrase" align="l" /></>} hint="At least 8 characters. Write it down: nobody can recover it, not even Veyl."><input id="bkP1" type="password" autoComplete="new-password" value={p1} onChange={(e) => setP1(e.target.value)} /></Field>
      <Field id="bkP2" label="Repeat it"><input id="bkP2" type="password" autoComplete="new-password" value={p2} onChange={(e) => setP2(e.target.value)} /></Field>
      <ErrorLine id="bkErr">{s.error}</ErrorLine>
      <button className="btn" type="button" id="bkGo" disabled={s.busy} onClick={submit}>{s.busy ? 'Locking…' : 'Save backup'}</button>
    </>
  );
}

function RestoreDialog() {
  const [file, setFile] = useState<File | null>(null), [pass, setPass] = useState('');
  const s = useSubmit(async () => {
    const E = engine(); const n = await E.importEncrypted(await file!.text(), pass);
    session.set({ activity: E.store.data.activity?.slice() || [] }); invalidate();
    showDone({ title: 'Restored', body: `${n} item${n === 1 ? '' : 's'} added. Your balance and positions are being read from the chain again.` });
  });
  return (
    <>
      <h3 id="dlgTitle">Restore from a backup<Tip term="restore" align="l" /></h3>
      <p>Adds a backup to this device. Nothing already here is removed.</p>
      <Field id="rsFile" label="Backup file"><input id="rsFile" type="file" accept="application/json,.json" onChange={(e) => setFile(e.target.files?.[0] || null)} /></Field>
      <Field id="rsP" label="Passphrase"><input id="rsP" type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} /></Field>
      <ErrorLine id="rsErr">{s.error}</ErrorLine>
      <button className="btn" type="button" id="rsGo" disabled={s.busy} onClick={() => (file ? s.run() : s.setError('Choose the backup file.'))}>{s.busy ? 'Decrypting…' : 'Restore'}</button>
    </>
  );
}
