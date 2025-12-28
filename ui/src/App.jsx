import { useEffect, useMemo, useRef, useState } from 'react'
import { QRCodeCanvas } from 'qrcode.react'

const API_BASE = import.meta.env.VITE_API_BASE || ''
const STATUS_STYLES = {
  pending: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
  active: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  paused: 'bg-orange-50 text-orange-700 ring-1 ring-orange-200',
  unregistered: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
  unknown: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
}

const normalizeStatus = (value) => {
  if (!value) return 'unknown'
  if (value === 'started') return 'active'
  return value
}

async function fetchJson(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, options)
  const data = await res.json()
  if (!res.ok) {
    throw new Error(data.error || 'Request failed.')
  }
  return data
}

function App() {
  const [contacts, setContacts] = useState([])
  const [schema, setSchema] = useState([])
  const [loading, setLoading] = useState(false)
  const [initiatingId, setInitiatingId] = useState(null)
  const [statusUpdatingId, setStatusUpdatingId] = useState(null)
  const [respondingId, setRespondingId] = useState(null)
  const [statusFilter, setStatusFilter] = useState('all')
  const [toast, setToast] = useState(null)
  const formRef = useRef(null)
  const [activeTab, setActiveTab] = useState('contacts')
  const [whatsappStatus, setWhatsappStatus] = useState('unknown')
  const [qrCode, setQrCode] = useState('')
  const [whatsappDetail, setWhatsappDetail] = useState('')
  const [whatsappUpdatedAt, setWhatsappUpdatedAt] = useState(null)

  useEffect(() => {
    loadSchema()
    loadContacts()
    loadWhatsappStatus()
    const interval = window.setInterval(loadWhatsappStatus, 5000)
    return () => window.clearInterval(interval)
  }, [])

  const stats = useMemo(() => {
    const total = contacts.length
    const pending = contacts.filter((c) => normalizeStatus(c.conversation_started) === 'pending').length
    const active = contacts.filter((c) => normalizeStatus(c.conversation_started) === 'active').length
    const paused = contacts.filter((c) => normalizeStatus(c.conversation_started) === 'paused').length
    const unregistered = contacts.filter((c) => normalizeStatus(c.conversation_started) === 'unregistered').length
    return { total, pending, active, paused, unregistered }
  }, [contacts])

  const filteredContacts = useMemo(() => {
    if (statusFilter === 'all') return contacts
    return contacts.filter(
      (contact) => normalizeStatus(contact.conversation_started) === statusFilter,
    )
  }, [contacts, statusFilter])

  async function loadContacts() {
    setLoading(true)
    try {
      const data = await fetchJson('/api/contacts')
      setContacts(data.contacts || [])
    } catch (err) {
      showToast(err.message, 'error')
    } finally {
      setLoading(false)
    }
  }

  async function loadSchema() {
    try {
      const data = await fetchJson('/api/contacts/schema')
      setSchema(data.columns || [])
    } catch (err) {
      showToast(err.message, 'error')
    }
  }

  async function loadWhatsappStatus() {
    try {
      const data = await fetchJson('/api/status')
      const nextStatus = data.whatsappReady
        ? 'ready'
        : data.status || 'not_ready'
      setWhatsappStatus(nextStatus)
      setQrCode(data.whatsappReady ? '' : data.qr || '')
      const detailParts = []
      if (data.connectionState) {
        detailParts.push(`State: ${data.connectionState}`)
      }
      if (typeof data.storeReady === 'boolean') {
        detailParts.push(`Store: ${data.storeReady ? 'ready' : 'loading'}`)
      }
      if (data.detail) {
        detailParts.push(data.detail)
      }
      setWhatsappDetail(detailParts.join(' • '))
      setWhatsappUpdatedAt(data.updatedAt || null)
    } catch (err) {
      setWhatsappStatus('offline')
      setQrCode('')
      setWhatsappDetail('')
      setWhatsappUpdatedAt(null)
    }
  }

  function showToast(message, tone = 'default') {
    setToast({ message, tone })
    window.clearTimeout(showToast._timer)
    showToast._timer = window.setTimeout(() => {
      setToast(null)
    }, 2400)
  }

  async function initiateContact(rowid) {
    setInitiatingId(rowid)
    try {
      await fetchJson(`/api/contacts/${rowid}/initiate`, { method: 'POST' })
      showToast('Conversation initiated.')
      loadContacts()
    } catch (err) {
      showToast(err.message, 'error')
    } finally {
      setInitiatingId(null)
    }
  }

  async function syncHistory(rowid) {
    try {
      await fetchJson(`/api/contacts/${rowid}/sync-history`, { method: 'POST' })
      showToast('History sync started.')
    } catch (err) {
      showToast(err.message, 'error')
    }
  }

  async function deleteContact(rowid) {
    const confirmed = window.confirm('Delete this contact?')
    if (!confirmed) return

    try {
      await fetchJson(`/api/contacts/${rowid}`, { method: 'DELETE' })
      showToast('Contact deleted.')
      loadContacts()
    } catch (err) {
      showToast(err.message, 'error')
    }
  }

  async function setContactStatus(rowid, status) {
    setStatusUpdatingId(rowid)
    try {
      await fetchJson(`/api/contacts/${rowid}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      showToast(`Status set to ${status}.`)
      loadContacts()
    } catch (err) {
      showToast(err.message, 'error')
    } finally {
      setStatusUpdatingId(null)
    }
  }

  async function respondWithLlm(rowid) {
    setRespondingId(rowid)
    try {
      const data = await fetchJson(`/api/contacts/${rowid}/respond`, { method: 'POST' })
      if (data.responded > 0) {
        showToast(`Sent ${data.responded} reply${data.responded > 1 ? 'ies' : ''}.`)
      } else {
        showToast('No unreplied messages found.')
      }
      if (data.paused) {
        loadContacts()
      }
    } catch (err) {
      showToast(err.message, 'error')
    } finally {
      setRespondingId(null)
    }
  }

  async function handleSubmit(event) {
    event.preventDefault()
    const payload = {}
    const formData = new FormData(event.currentTarget)
    schema.forEach((column) => {
      payload[column.name] = formData.get(column.name) ?? ''
    })
    try {
      await fetchJson('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (formRef.current) {
        formRef.current.reset()
      }
      showToast('Contact added.')
      loadContacts()
    } catch (err) {
      showToast(err.message, 'error')
    }
  }

  function resetForm(event) {
    event.preventDefault()
    if (formRef.current) {
      formRef.current.reset()
    }
  }

  return (
    <div className="min-h-screen px-6 py-10 font-sans">
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        <header className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-gray-500">
              Whatsapp LLM bot
            </p>
            <h1 className="mt-3 text-3xl font-semibold text-gray-900 md:text-4xl">
              Contact List
            </h1>
            <p className="mt-2 max-w-xl text-sm text-gray-600">
              Review contacts from your database and trigger conversation initiation.
            </p>
            <div className="mt-4 flex items-center gap-2 text-sm font-semibold text-gray-700">
              <span
                className={`inline-flex h-2.5 w-2.5 rounded-full ${
                  whatsappStatus === 'ready'
                    ? 'bg-emerald-500'
                    : whatsappStatus === 'qr' || whatsappStatus === 'not_ready'
                    ? 'bg-amber-500'
                    : 'bg-gray-400'
                }`}
              />
              {whatsappStatus === 'ready' && 'WhatsApp connected'}
              {(whatsappStatus === 'qr' || whatsappStatus === 'not_ready') &&
                'WhatsApp not ready (scan QR)'}
              {whatsappStatus === 'authenticated' && 'WhatsApp linked, syncing...'}
              {whatsappStatus === 'loading' && 'WhatsApp loading...'}
              {whatsappStatus === 'state' && 'WhatsApp state change detected'}
              {whatsappStatus === 'auth_failure' && 'WhatsApp auth failed'}
              {whatsappStatus === 'disconnected' && 'WhatsApp disconnected'}
              {whatsappStatus === 'offline' && 'WhatsApp status unavailable'}
              {whatsappStatus === 'unknown' && 'Checking WhatsApp status...'}
            </div>
            {(whatsappDetail || whatsappUpdatedAt) && (
              <div className="mt-2 text-xs text-gray-500">
                {whatsappDetail && <span>{whatsappDetail}</span>}
                {whatsappDetail && whatsappUpdatedAt && <span> • </span>}
                {whatsappUpdatedAt && (
                  <span>
                    Updated {new Date(whatsappUpdatedAt).toLocaleTimeString()}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            {[
              { label: 'Total', value: stats.total },
              { label: 'Pending', value: stats.pending },
              { label: 'Active', value: stats.active },
              { label: 'Paused', value: stats.paused },
              { label: 'Unregistered', value: stats.unregistered },
            ].map((stat) => (
              <div key={stat.label} className="rounded-xl border border-gray-200 bg-white p-4">
                <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">
                  {stat.label}
                </p>
                <p className="mt-2 text-2xl font-semibold text-gray-900">{stat.value}</p>
              </div>
            ))}
          </div>
        </header>

        {(whatsappStatus === 'qr' || whatsappStatus === 'not_ready') && qrCode && (
          <section className="rounded-2xl border border-amber-200 bg-amber-50/60 p-6 text-sm text-amber-900 shadow-sm">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.25em] text-amber-700">
                  WhatsApp Login
                </p>
                <h2 className="mt-2 text-lg font-semibold text-amber-900">
                  Scan this QR code with WhatsApp on your phone
                </h2>
                <p className="mt-1 text-sm text-amber-700">
                  Open WhatsApp &gt; Linked Devices &gt; Link a Device.
                </p>
              </div>
              <div className="rounded-2xl border border-amber-200 bg-white p-4">
                <QRCodeCanvas value={qrCode} size={168} />
              </div>
            </div>
          </section>
        )}

        <nav className="flex flex-wrap gap-3 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          {[
            { id: 'contacts', label: 'Contacts' },
            { id: 'add', label: 'Add Contact' },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                activeTab === tab.id
                  ? 'bg-gray-900 text-white'
                  : 'border border-gray-200 text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {activeTab === 'contacts' && (
          <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h2 className="text-lg font-semibold text-gray-900">Contacts</h2>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex flex-wrap gap-2">
                {[
                  { id: 'all', label: 'All' },
                  { id: 'pending', label: 'Pending' },
                  { id: 'active', label: 'Active' },
                  { id: 'paused', label: 'Paused' },
                  { id: 'unregistered', label: 'Unregistered' },
                ].map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setStatusFilter(option.id)}
                    className={`rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition ${
                      statusFilter === option.id
                        ? 'bg-gray-900 text-white'
                        : 'border border-gray-200 text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={loadContacts}
                className="rounded-full border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700 transition hover:border-gray-300"
              >
                Refresh
              </button>
            </div>
          </div>

          <div className="mt-6 grid gap-4">
            {loading && (
              <div className="rounded-xl border border-dashed border-gray-200 p-6 text-center text-sm text-gray-500">
                Loading contacts...
              </div>
            )}
            {!loading && filteredContacts.length === 0 && (
              <div className="rounded-xl border border-dashed border-gray-200 p-6 text-center text-sm text-gray-500">
                No contacts found for this filter.
              </div>
            )}
            {!loading &&
              filteredContacts.map((contact) => {
                const status = normalizeStatus(contact.conversation_started)
                const metaParts = [
                  contact.group ? `Group: ${contact.group}` : null,
                  contact.agentName && contact.agentName !== contact.contactName
                    ? `Agent: ${contact.agentName}`
                    : null,
                ].filter(Boolean)

                return (
                  <div
                    key={contact.rowid}
                    className="flex flex-col gap-4 rounded-2xl border border-gray-200 bg-gray-50/60 p-4 md:flex-row md:items-center md:justify-between"
                  >
                    <div>
                      <p className="text-base font-semibold text-gray-900">
                        {contact.contactName || contact.agentName || 'Unknown contact'}
                      </p>
                      <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                        Row ID: {contact.rowid}
                      </p>
                      {metaParts.length > 0 && (
                        <p className="mt-1 text-sm text-gray-600">{metaParts.join(' / ')}</p>
                      )}
                      <p className="mt-2 text-sm font-mono text-gray-600">
                        {contact.cleanContactNumber || 'No cleanContactNumber'}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <span
                        className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ${STATUS_STYLES[status] || STATUS_STYLES.unknown}`}
                      >
                        {status}
                      </span>
                      <button
                        type="button"
                        onClick={() => initiateContact(contact.rowid)}
                        disabled={
                          status === 'active' ||
                          status === 'paused' ||
                          status === 'unregistered' ||
                          initiatingId === contact.rowid
                        }
                        className="rounded-full bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300"
                      >
                        {status === 'active'
                          ? 'Active'
                          : status === 'paused'
                          ? 'Paused'
                          : status === 'unregistered'
                          ? 'Unregistered'
                          : initiatingId === contact.rowid
                          ? 'Sending...'
                          : 'Initiate'}
                      </button>
                      {status !== 'active' && status !== 'unregistered' && (
                        <button
                          type="button"
                          onClick={() => setContactStatus(contact.rowid, 'active')}
                          disabled={statusUpdatingId === contact.rowid}
                          className="rounded-full border border-emerald-200 px-4 py-2 text-sm font-semibold text-emerald-700 transition hover:border-emerald-300 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Set active
                        </button>
                      )}
                      {status === 'active' && (
                        <button
                          type="button"
                          onClick={() => setContactStatus(contact.rowid, 'paused')}
                          disabled={statusUpdatingId === contact.rowid}
                          className="rounded-full border border-orange-200 px-4 py-2 text-sm font-semibold text-orange-700 transition hover:border-orange-300 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Pause
                        </button>
                      )}
                      {status !== 'unregistered' && (
                        <button
                          type="button"
                          onClick={() => respondWithLlm(contact.rowid)}
                          disabled={respondingId === contact.rowid}
                          className="rounded-full border border-sky-200 px-4 py-2 text-sm font-semibold text-sky-700 transition hover:border-sky-300 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {respondingId === contact.rowid ? 'Responding...' : 'Respond'}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => syncHistory(contact.rowid)}
                        className="rounded-full border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700 transition hover:border-gray-300"
                      >
                        Sync history
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteContact(contact.rowid)}
                        className="rounded-full border border-rose-200 px-4 py-2 text-sm font-semibold text-rose-600 transition hover:border-rose-300 hover:bg-rose-50"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )
              })}
          </div>
          </section>
        )}

        {activeTab === 'add' && (
          <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h2 className="text-lg font-semibold text-gray-900">Add Contact</h2>
            <button
              type="button"
              onClick={resetForm}
              className="rounded-full border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700 transition hover:border-gray-300"
            >
              Reset
            </button>
          </div>
          <form ref={formRef} onSubmit={handleSubmit} className="mt-6">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {schema.map((column) => {
                const isTextarea = column.name === 'notes'
                return (
                  <label key={column.name} className="flex flex-col gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                    {column.name}
                    {isTextarea ? (
                      <textarea
                        name={column.name}
                        defaultValue={column.name === 'conversation_started' ? 'pending' : ''}
                        placeholder={column.defaultValue || ''}
                        className="min-h-[84px] rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-normal text-gray-900 focus:border-gray-400 focus:outline-none"
                      />
                    ) : (
                      <input
                        name={column.name}
                        type="text"
                        defaultValue={column.name === 'conversation_started' ? 'pending' : ''}
                        placeholder={column.defaultValue || ''}
                        className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-normal text-gray-900 focus:border-gray-400 focus:outline-none"
                      />
                    )}
                  </label>
                )
              })}
            </div>
            <div className="mt-6 flex justify-end">
              <button
                type="submit"
                className="rounded-full bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-gray-800"
              >
                Add Contact
              </button>
            </div>
          </form>
          </section>
        )}
      </div>

      {toast && (
        <div
          className={`fixed bottom-6 right-6 rounded-xl px-4 py-3 text-sm font-semibold text-white shadow-lg ${
            toast.tone === 'error' ? 'bg-rose-600' : 'bg-gray-900'
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  )
}

export default App
