/**
 * Money: where your company's credits actually are. Your wallet on NEAR testnet, the treasury every credit came
 * from, the NPCs' own wallets, and every transaction, each with a link to check it yourself.
 */
import { useEffect, useState } from 'react'
import type { EconomyView } from '@blackout/shared'
import { regionApi } from '../api'
import { credits } from '../format'
import { Bar, Section, Stat } from './Bits'

/** Your wallet's key, shown once on request: for a backup, or to open the account in any NEAR wallet. */
function KeyExport({ accountId }: { accountId: string }) {
  const [step, setStep] = useState<'closed' | 'confirm' | 'shown'>('closed')
  const [key, setKey] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const reveal = async () => {
    setErr(null)
    try {
      setKey((await regionApi.exportKey()).privateKey)
      setStep('shown')
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  if (step === 'closed')
    return (
      <button className="btn small" onClick={() => setStep('confirm')}>
        🔑 Back up my wallet key
      </button>
    )
  if (step === 'confirm')
    return (
      <div className="key-export">
        <p className="fine">
          This shows the private key of <b>{accountId}</b>. With it you can open this account in any NEAR testnet wallet
          (for example MyNearWallet or Meteor: “import account → private key”) and keep a copy if this server ever goes away.
        </p>
        <p className="warn-line">Anyone who sees this key controls the account. Don’t share it, screenshot it or paste it anywhere you don’t trust. The game keeps its own encrypted copy so it can keep settling your trades.</p>
        <div className="row">
          <button className="btn primary small" onClick={() => void reveal()}>
            I understand, show it once
          </button>
          <button className="btn small" onClick={() => setStep('closed')}>
            Cancel
          </button>
        </div>
        {err && <p className="warn-line">{err}</p>}
      </div>
    )
  return (
    <div className="key-export">
      <p className="fine">Your key for {accountId} (testnet):</p>
      <code className="key-box">{key}</code>
      <div className="row">
        <button
          className="btn small"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(key ?? '')
              setCopied(true)
            } catch {
              setCopied(false)
            }
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          className="btn small"
          onClick={() => {
            setKey(null)
            setStep('closed')
          }}
        >
          Hide it
        </button>
      </div>
    </div>
  )
}

/** Withdraw everything to your own wallet and end the game's custody of it, for good. */
function LeaveCustody() {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  if (!open)
    return (
      <button className="btn small ghost" onClick={() => setOpen(true)}>
        Take my money and leave game custody…
      </button>
    )
  return (
    <div className="key-export">
      <p className="fine">
        This moves <b>all of your company’s cash</b> into your wallet on NEAR, and then your wallet tells the contract to stop the game ever moving its tokens again (<code>release_to_owner</code>). The money is then yours alone: back up your key first, because only that key can reach it.
      </p>
      <p className="warn-line">You can’t undo this. Your company keeps playing, but with game money only: what it earns from now on stays in the game, and nothing is settled to this wallet any more.</p>
      <label className="slider">
        Type LEAVE to confirm
        <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="LEAVE" />
      </label>
      <div className="row">
        <button
          className="btn primary small"
          disabled={busy || typed !== 'LEAVE'}
          onClick={async () => {
            setBusy(true)
            try {
              const r = await regionApi.leaveCustody()
              setMsg({ text: r.detail, ok: r.status !== 'waiting' })
            } catch (e) {
              setMsg({ text: (e as Error).message, ok: false })
            } finally {
              setBusy(false)
            }
          }}
        >
          Withdraw and leave
        </button>
        <button className="btn small" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {msg && <p className={msg.ok ? 'ok-line' : 'warn-line'}>{msg.text}</p>}
    </div>
  )
}

const OP_STATUS = { created: 'queued', submitted: 'waiting for NEAR', settled: 'confirmed', failed: 'failed', local: 'game server only' } as const

export function Money() {
  const [e, setE] = useState<EconomyView | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const load = () => regionApi.economy().then((r) => live && setE(r.economy), (x) => live && setErr((x as Error).message))
    void load()
    const t = setInterval(load, 5_000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [])
  if (err && !e) return <p className="warn">{err}</p>
  if (!e) return <p className="fine">Reading the ledger…</p>
  const near = e.mode === 'near'
  return (
    <>
      <h3>Money</h3>
      {near ? (
        <p className="fine">
          Every credit in Vesper is a token on NEAR testnet, in one contract (<a href={e.contractUrl!} target="_blank" rel="noreferrer">{e.contractId}</a>). The treasury minted all of them once; nobody can print more. You never sign anything or pay fees: the game does that for you.
        </p>
      ) : (
        <p className="warn-line">This server isn’t connected to NEAR testnet, so your credits live on the game server only. Nothing here is on a blockchain.</p>
      )}

      <Section title="Your wallet">
        {e.wallet ? (
          <>
            <Stat label="Account" value={e.wallet.explorerUrl ? <a href={e.wallet.explorerUrl} target="_blank" rel="noreferrer">{e.wallet.accountId} ↗</a> : e.wallet.accountId} />
            <Stat label="Status" value={{ creating: 'being created on NEAR…', opening: 'receiving its starting capital…', active: 'open', leaving: 'leaving game custody…', released: 'yours alone (out of game custody)', failed: 'couldn’t be created' }[e.wallet.status]} tone={e.wallet.status === 'active' || e.wallet.status === 'released' ? 'ok' : e.wallet.status === 'failed' ? 'crisis' : undefined} />
            <Stat label="On NEAR" value={e.wallet.onChainCc === null ? '…' : credits(e.wallet.onChainCc)} />
            <Stat label="In the game" value={credits(e.wallet.gameCashCc)} />
            {e.wallet.unsettledCc !== null && <Stat label="Not settled yet" value={credits(e.wallet.unsettledCc)} tone={Math.abs(e.wallet.unsettledCc) > 0 ? 'muted' : undefined} />}
            <p className="fine">Starting capital: {credits(e.wallet.startingGrantCc)} from the treasury, once. What you earn and spend settles to this wallet every few seconds: power sales come straight from the companies that bought them; everything else is batched.</p>
            {e.wallet.detail && <p className="warn-line">{e.wallet.detail}</p>}
            {(e.wallet.status === 'active' || e.wallet.status === 'released') && near && <KeyExport accountId={e.wallet.accountId} />}
            {e.wallet.status === 'active' && near && <LeaveCustody />}
            {e.wallet.status === 'released' && <p className="fine">This wallet is out of the game’s custody: its credits and plants are yours alone, reachable only with your key. Your company plays on with game money.</p>}
          </>
        ) : (
          <p className="fine">{e.walletNote}</p>
        )}
      </Section>

      {e.treasury && (
        <Section title="The treasury">
          <Stat label="Credits that exist" value={credits(e.treasury.totalSupplyCc)} />
          <Stat label="Still in the treasury" value={credits(e.treasury.treasuryBalanceCc)} />
          <Stat label="Created since genesis" value={`${credits(e.treasury.issuedCc)} of ${credits(e.treasury.issueCapCc)} allowed`} />
          {e.treasury.buckets.map((b) => (
            <div key={b.name} className="bucket">
              <div className="kv">
                <span>{{ city: 'City budget (pays your region’s power bills)', world: 'Outside world (imports and customers)', npc: 'NPC starting capital', players: 'Players’ starting capital', reserve: 'Reserve' }[b.name] ?? b.name}</span>
                <b>
                  {credits(b.grantedCc)} / {credits(b.capCc)}
                </b>
              </div>
              <Bar value={b.grantedCc} max={b.capCc} tone="gold" label={b.name} />
            </div>
          ))}
          {e.treasury.npcSpendingPaused && <p className="warn-line">NPC spending is paused (emergency switch).</p>}
        </Section>
      )}

      {near && (
        <Section title="Who holds the rest">
          {e.grid && <Stat label={<a href={e.grid.explorerUrl} target="_blank" rel="noreferrer">Grid clearing ↗</a> } value={e.grid.onChainCc === null ? '…' : credits(e.grid.onChainCc)} />}
          {e.world && <Stat label={<a href={e.world.explorerUrl} target="_blank" rel="noreferrer">Outside world ↗</a> } value={e.world.onChainCc === null ? '…' : credits(e.world.onChainCc)} />}
          {e.npcs.map((n) => (
            <div key={n.id} className="kv">
              <span>
                <a href={n.explorerUrl} target="_blank" rel="noreferrer">
                  {n.name}
                </a>{' '}
                <small>{n.kind === 'company' ? 'company' : 'merchant'}</small>
              </span>
              <b title="on NEAR / in the game">
                {n.onChainCc === null ? '…' : credits(n.onChainCc)} <small className="muted">/ {credits(n.gameCashCc)}</small>
              </b>
            </div>
          ))}
          <p className="fine">On NEAR / in the game. The two differ only by trades not yet settled (seconds) and power payments waiting in escrow.</p>
        </Section>
      )}

      {e.plants.length > 0 && (
        <Section title="Your plants on NEAR">
          <p className="fine">Each plant you own is an NFT in your wallet with its own account. Sell one and it leaves your wallet; buy or build one and it arrives.</p>
          {e.plants.map((p) => (
            <div key={p.tokenId} className="kv">
              <span>
                {p.url ? (
                  <a href={p.url} target="_blank" rel="noreferrer">
                    {p.name}
                  </a>
                ) : (
                  p.name
                )}{' '}
                <small className="muted">{p.tokenId}</small>
              </span>
              <b className={p.status === 'yours' ? 'ok' : p.status === 'failed' ? 'warn' : 'muted'}>
                {{ minting: 'being minted…', yours: 'yours', sold: 'sold', failed: 'not minted' }[p.status]}
                {p.txUrl && (
                  <>
                    {' '}
                    <a className="tx-link" href={p.txUrl} target="_blank" rel="noreferrer">
                      ↗
                    </a>
                  </>
                )}
              </b>
            </div>
          ))}
        </Section>
      )}

      <Section title="Transactions">
        {e.ops.length === 0 && <p className="fine">Nothing yet.</p>}
        <ul className="ops">
          {e.ops.map((o) => (
            <li key={o.opId}>
              <span className={`pill ${o.status === 'settled' ? 'ok' : o.status === 'failed' ? 'warn' : 'muted'}`}>{OP_STATUS[o.status]}</span> {o.label}
              {o.txUrl && (
                <>
                  {' '}
                  <a className="tx-link" href={o.txUrl} target="_blank" rel="noreferrer">
                    transaction ↗
                  </a>
                </>
              )}
              {o.detail && <small className="warn-line"> {o.detail}</small>}
            </li>
          ))}
        </ul>
      </Section>
      {!near && e.missing.length > 0 && <p className="fine">To connect: run <code>pnpm chain:economy</code> with a funded testnet account (see docs/TESTNET_DEMO.md).</p>}
    </>
  )
}
