/**
 * Hot Desk dilemma call UI.
 * Displays an incoming call from one of Vesper's civic or industrial leaders (`v.hotDesk`)
 * and dispatches the deterministic `ANSWER_HOT_DESK` action to the region engine.
 */
import { useState } from 'react'
import type { HotDeskCallView } from '@blackout/shared'

export function HotDeskCard({
  call,
  onAnswer,
}: {
  call: HotDeskCallView
  onAnswer: (callId: string, choice: 'accept' | 'decline') => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  const handle = async (choice: 'accept' | 'decline') => {
    setBusy(true)
    try {
      await onAnswer(call.callId, choice)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="hot-desk-call" role="region" aria-label="Hot Desk call" style={{ paddingTop: 8, borderTop: '1px solid rgba(251, 191, 36, 0.28)' }}>
      <div className="operation-heading" style={{ marginBottom: 2 }}>
        <span className="operation-kicker">☎️ HOT DESK · INCOMING CALL</span>
      </div>
      <small className="fine" style={{ display: 'block', marginBottom: 4, fontSize: 11 }}>
        {call.face} <b>{call.person}</b> · {call.role}
      </small>
      <strong style={{ display: 'block', color: '#fff', fontSize: 13, marginBottom: 3 }}>{call.title}</strong>
      <p className="fine" style={{ margin: '0 0 6px', fontSize: 11.5, lineHeight: 1.38 }}>
        “{call.message}”
      </p>
      <small className="fine" style={{ display: 'block', marginBottom: 6, color: '#dff9ef', fontSize: 10.5 }}>
        {call.acceptEffect}
      </small>
      {!call.canAccept && call.cannotAcceptReason && (
        <small className="warn-line" style={{ display: 'block', marginBottom: 6, fontSize: 10.5 }}>
          {call.cannotAcceptReason}
        </small>
      )}
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn primary small"
          disabled={busy || !call.canAccept}
          onClick={() => void handle('accept')}
        >
          {call.acceptLabel}
        </button>
        <button
          type="button"
          className="btn ghost small"
          disabled={busy}
          onClick={() => void handle('decline')}
        >
          {call.declineLabel}
        </button>
      </div>
    </div>
  )
}
