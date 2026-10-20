import { useCallback, useEffect, useState } from 'react';
import { authClient } from '../lib/auth.js';
import { DataTable, ErrorNotice } from './ui.js';

const ROLES = ['viewer', 'analyst', 'growth_operator', 'approver', 'finance_approver', 'legal_approver', 'privacy_officer', 'admin'] as const;

type Row = Record<string, unknown>;

/**
 * Organization members and invitations. There is no outbound email in the beta (B-008): the
 * inviter shares the invitation link through a channel they trust; the link only works for the
 * invited address and expires after 72 hours.
 */
export function Members({ tenantId, canManage }: { tenantId: string; canManage: boolean }) {
  const [members, setMembers] = useState<Row[]>([]);
  const [invites, setInvites] = useState<Row[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<(typeof ROLES)[number]>('viewer');
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    const m = await authClient.organization.listMembers({ query: { organizationId: tenantId } });
    if (m.error) return setError(new Error(m.error.message ?? 'could not list members'));
    const rows = (m.data as { members?: Row[] } | Row[] | null) ?? [];
    setMembers((Array.isArray(rows) ? rows : (rows.members ?? [])).map((x) => ({ ...x, email: (x.user as { email?: string } | undefined)?.email ?? x.email })));
    if (canManage) {
      const i = await authClient.organization.listInvitations({ query: { organizationId: tenantId } });
      if (!i.error) setInvites(((i.data as Row[] | null) ?? []).filter((x) => x.status === 'pending'));
    }
  }, [tenantId, canManage]);

  useEffect(() => {
    void load();
  }, [load]);

  const invite = async () => {
    setError(null);
    setLink(null);
    // The client plugin is typed with Better Auth's default roles; the server validates our custom roles (apps/api/src/auth.ts).
    const r = await authClient.organization.inviteMember({ email: email.trim(), role: role as 'admin', organizationId: tenantId });
    if (r.error) return setError(new Error(r.error.message ?? 'could not invite'));
    const id = (r.data as { id?: string } | null)?.id;
    if (id) setLink(`${window.location.origin}/invite?id=${encodeURIComponent(id)}`);
    setEmail('');
    await load();
  };

  const cancel = async (id: string) => {
    const r = await authClient.organization.cancelInvitation({ invitationId: id });
    if (r.error) return setError(new Error(r.error.message ?? 'could not cancel'));
    await load();
  };

  return (
    <section className="card">
      <h2>Members</h2>
      <ErrorNotice error={error} />
      <DataTable rows={members} columns={['email', 'role', 'createdAt']} empty="No members." />
      {canManage ? (
        <div className="stack" style={{ marginTop: '1rem' }}>
          <h3>Invite someone</h3>
          <div className="row" style={{ alignItems: 'end' }}>
            <div className="field" style={{ flex: '1 1 16rem' }}>
              <label htmlFor="invite-email">Email</label>
              <input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="invite-role">Role</label>
              <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}>
                {ROLES.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <button type="button" className="primary" disabled={!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())} onClick={() => void invite()}>
                Create invitation
              </button>
            </div>
          </div>
          {link ? (
            <div className="notice ok">
              Share this link with the invitee through a channel you trust. It works only for that address and expires in 72 hours.
              <div>
                <code className="mono">{link}</code>
              </div>
            </div>
          ) : null}
          <DataTable
            rows={invites}
            columns={['email', 'role', 'expiresAt']}
            actions={(r) => (
              <button type="button" onClick={() => void cancel(String(r.id))}>
                Cancel
              </button>
            )}
            empty="No pending invitations."
          />
        </div>
      ) : null}
    </section>
  );
}
