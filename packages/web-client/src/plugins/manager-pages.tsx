import { useCallback, useEffect, useMemo, useState } from 'react'
import { connection } from '../connection.ts'
import type { ClientPlugin, PageProps } from '../slots.ts'
import { Json } from './tool-views.tsx'

/**
 * Trang quản lý plugin và tool, theo mẫu Plugin Manager của dsh.
 * Mọi thay đổi gọi method `plugins.*`, `tools.*`, `mcp.*` của plugin `plugin-manager` phía Host.
 */
export const managerPages: ClientPlugin = (s) => {
  s.page.register('plugins', { id: 'plugins', title: 'Plugin', order: 10, component: PluginsPage })
  s.page.register('tools', { id: 'tools', title: 'Tool', order: 20, component: ToolsPage })
}

interface Field { key: string; type: string; description?: string; default?: unknown; required?: boolean; options?: unknown[] }

interface PluginInfo {
  id: string; name: string; layer: string; status: string; error?: string; disabled: boolean
  locked: boolean; removable: boolean; config: Record<string, unknown>; fields: Field[]; tools: string[]
}

interface ToolInfo {
  name: string; namespace: string; description: string; scopes: string[]; readOnly: boolean; always: boolean
  owner?: string; mcp: boolean; enabled: boolean; tryable: boolean; inputSchema: any
}

interface CatalogItem { name: string; source: string; loaded: boolean; fields: Field[] }

const STATUS: Record<string, string> = {
  active: 'Đang chạy', disabled: 'Đã tắt', failed: 'Lỗi', pending: 'Chờ service', loading: 'Đang nạp',
}
const LAYER: Record<string, string> = {
  builtin: 'lõi', config: 'cấu hình', patch: 'thêm từ giao diện', override: 'ghi đè',
}

function useRemote<T>(method: string) {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string>()
  const reload = useCallback(() => {
    connection.call<T>(method).then(setData, (e) => setError(e.message))
  }, [method])
  useEffect(reload, [reload])
  return { data, error, reload }
}

function PluginsPage(_: PageProps) {
  const { data: plugins, reload } = useRemote<PluginInfo[]>('plugins.list')
  const [dialog, setDialog] = useState<'plugin' | 'mcp'>()
  const [filter, setFilter] = useState('')
  const shown = (plugins ?? []).filter((p) => `${p.id} ${p.name} ${p.tools.join(' ')}`.toLowerCase().includes(filter.toLowerCase()))
  return (
    <main className="manager">
      <header>
        <h2>Plugin</h2>
        <input placeholder="Lọc theo tên, package, tool…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button onClick={() => setDialog('plugin')}>+ Thêm plugin</button>
        <button className="primary" onClick={() => setDialog('mcp')}>+ Thêm MCP server</button>
      </header>
      <p className="muted">Thay đổi được ghi vào patch layer (<code>*.patch.yml</code> cạnh file cấu hình), không sửa file cấu hình gốc.</p>
      {dialog === 'plugin' && <AddPlugin onClose={() => setDialog(undefined)} onDone={reload} />}
      {dialog === 'mcp' && <AddMcp onClose={() => setDialog(undefined)} onDone={reload} />}
      <div className="cards">
        {shown.map((p) => <PluginCard key={p.id} plugin={p} onChange={reload} />)}
      </div>
    </main>
  )
}

function PluginCard({ plugin, onChange }: { plugin: PluginInfo; onChange(): void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const run = async (method: string, params: Record<string, unknown>) => {
    setBusy(true)
    setError(undefined)
    try {
      await connection.call(method, params)
      onChange()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className={`card status-${plugin.status}`}>
      <div className="card-head">
        <span className={`badge ${plugin.status}`}>{STATUS[plugin.status] ?? plugin.status}</span>
        <div className="card-title">
          <b>{plugin.id}</b>
          <code>{plugin.name}</code>
        </div>
        <span className="muted small">{LAYER[plugin.layer] ?? plugin.layer}</span>
        <label className={`switch ${plugin.locked ? 'locked' : ''}`} title={plugin.locked ? 'Giao diện phụ thuộc plugin này' : ''}>
          <input
            type="checkbox"
            role="switch"
            checked={!plugin.disabled}
            disabled={plugin.locked || busy}
            onChange={(e) => run('plugins.setEnabled', { id: plugin.id, enabled: e.target.checked })}
          />
          <span />
        </label>
      </div>
      {plugin.error && <div className="bad small">{plugin.error}</div>}
      {plugin.tools.length > 0 && <div className="tags">{plugin.tools.map((t) => <span key={t} className="tag">{t}</span>)}</div>}
      <div className="actions">
        <button onClick={() => setOpen(!open)}>{open ? 'Đóng cấu hình' : 'Cấu hình'}</button>
        {plugin.removable && <button disabled={busy} onClick={() => run('plugins.remove', { id: plugin.id })}>Gỡ</button>}
      </div>
      {open && (
        <ConfigForm
          fields={plugin.fields}
          value={plugin.config}
          disabled={busy || plugin.id === 'plugin-manager'}
          submitLabel="Lưu và nạp lại"
          onSubmit={(config) => run('plugins.configure', { id: plugin.id, config })}
        />
      )}
      {error && <div className="bad small">{error}</div>}
    </section>
  )
}

/**
 * Form cấu hình dựng từ schema của plugin: chuỗi, số, boolean, lựa chọn hiển thị ô nhập riêng;
 * mảng và object nhập dạng JSON. Chế độ JSON cho phép sửa toàn bộ cấu hình.
 */
function ConfigForm({ fields, value, disabled, submitLabel, onSubmit }: {
  fields: Field[]; value: Record<string, unknown>; disabled?: boolean; submitLabel: string
  onSubmit(config: Record<string, unknown>): void
}) {
  const [raw, setRaw] = useState(!fields.length)
  const [text, setText] = useState(JSON.stringify(value ?? {}, null, 2))
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, toText(value?.[f.key])])))
  const [error, setError] = useState<string>()

  const submit = () => {
    setError(undefined)
    try {
      if (raw) return onSubmit(JSON.parse(text || '{}'))
      const config: Record<string, unknown> = {}
      for (const field of fields) {
        const input = draft[field.key]
        if (input === '' || input === undefined) continue
        config[field.key] = fromText(field, input)
      }
      onSubmit(config)
    } catch (e) {
      setError(`Giá trị không hợp lệ: ${(e as Error).message}`)
    }
  }

  return (
    <div className="config-form">
      <div className="actions">
        <button className={raw ? '' : 'active'} disabled={!fields.length} onClick={() => setRaw(false)}>Form</button>
        <button className={raw ? 'active' : ''} onClick={() => setRaw(true)}>JSON</button>
      </div>
      {raw ? (
        <textarea className="editor small" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
      ) : fields.map((field) => (
        <label key={field.key} className="field">
          <span className="field-name">{field.key}{field.required && ' *'} <code className="muted">{field.type}</code></span>
          {field.description && <span className="muted small">{field.description}</span>}
          {field.options ? (
            <select value={draft[field.key]} onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}>
              <option value="">(mặc định{field.default !== undefined ? `: ${String(field.default)}` : ''})</option>
              {field.options.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
            </select>
          ) : field.type === 'boolean' ? (
            <select value={draft[field.key]} onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}>
              <option value="">(mặc định{field.default !== undefined ? `: ${String(field.default)}` : ''})</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : isStructured(field) ? (
            <textarea
              className="editor small"
              spellCheck={false}
              placeholder={field.default !== undefined ? JSON.stringify(field.default) : ''}
              value={draft[field.key]}
              onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
            />
          ) : (
            <input
              value={draft[field.key]}
              placeholder={field.default !== undefined ? String(field.default) : ''}
              onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
            />
          )}
        </label>
      ))}
      <div className="actions">
        <button className="primary" disabled={disabled} onClick={submit}>{submitLabel}</button>
      </div>
      {error && <div className="bad small">{error}</div>}
    </div>
  )
}

const isStructured = (field: Field) => field.type.endsWith('[]') || field.type.startsWith('Record') || field.type === 'object'

function toText(value: unknown) {
  if (value === undefined) return ''
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
}

function fromText(field: Field, input: string): unknown {
  if (isStructured(field)) return JSON.parse(input)
  if (field.type === 'number') return Number(input)
  if (field.type === 'boolean') return input === 'true'
  return input
}

function AddPlugin({ onClose, onDone }: { onClose(): void; onDone(): void }) {
  const { data: catalog } = useRemote<CatalogItem[]>('plugins.catalog')
  const [selected, setSelected] = useState<CatalogItem>()
  const [id, setId] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const available = (catalog ?? []).filter((c) => !c.loaded)
  const add = async (config: Record<string, unknown>) => {
    setBusy(true)
    setError(undefined)
    try {
      await connection.call('plugins.add', { id, name: selected!.name, config })
      onDone()
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="dialog">
      <header><h3>Thêm plugin</h3><button onClick={onClose}>Đóng</button></header>
      {!catalog && <div className="muted">Đang tải danh mục…</div>}
      {catalog && !available.length && <div className="muted">Mọi plugin trong danh mục đã được nạp.</div>}
      <div className="catalog">
        {available.map((item) => (
          <button
            key={item.name}
            className={item.name === selected?.name ? 'active' : ''}
            onClick={() => { setSelected(item); setId(suggestId(item.name)) }}
          >
            <code>{item.name}</code> <span className="muted small">{item.source === 'local' ? 'cục bộ' : 'package'}</span>
          </button>
        ))}
      </div>
      {selected && (
        <>
          <label className="field"><span className="field-name">Mã row (id) *</span><input value={id} onChange={(e) => setId(e.target.value)} /></label>
          <ConfigForm fields={selected.fields} value={{}} disabled={busy || !id} submitLabel="Thêm plugin" onSubmit={add} />
        </>
      )}
      {error && <div className="bad small">{error}</div>}
    </section>
  )
}

function suggestId(name: string) {
  return name.replace(/^@aitest\//, '').replace(/^\.\/.*\//, '').replace(/\.(ts|js|mjs)$/, '').replace(/[^\w.-]/g, '-')
}

/** Server vừa thêm, chuyển sang bước đánh dấu tool chỉ đọc. */
interface AddedServer { name: string; id: string }

function AddMcp({ onClose, onDone }: { onClose(): void; onDone(): void }) {
  const [mode, setMode] = useState<'paste' | 'form'>('paste')
  const [added, setAdded] = useState<AddedServer[]>()
  const onAdded = (servers: AddedServer[]) => { onDone(); setAdded(servers) }
  return (
    <section className="dialog">
      <header><h3>Thêm MCP server vào aitest</h3><button onClick={onClose}>Đóng</button></header>
      <p className="muted small">
        Tool của server được đăng ký thành action <code>&lt;namespace&gt;_&lt;tool&gt;</code>, đi qua guard, evidence và run log như action nội bộ.
        Agent của aitest chỉ dùng MCP server thêm tại đây; server khai báo trong cấu hình riêng của Kiro (<code>~/.kiro/settings/mcp.json</code>) không được dùng.
      </p>
      {added ? <McpReadOnly servers={added} onClose={onClose} onDone={onDone} /> : (
        <>
          <div className="tabs">
            <button className={mode === 'paste' ? 'active' : ''} onClick={() => setMode('paste')}>Dán cấu hình</button>
            <button className={mode === 'form' ? 'active' : ''} onClick={() => setMode('form')}>Điền form</button>
          </div>
          {mode === 'paste' ? <PasteMcp onAdded={onAdded} /> : <McpForm onAdded={onAdded} />}
        </>
      )}
    </section>
  )
}

/** Các bước của hộp thoại; bước hiện tại được tô đậm. */
function Steps({ current }: { current: 1 | 2 | 3 }) {
  const steps = ['Dán cấu hình', 'Xem trước và chọn server', 'Đánh dấu tool chỉ đọc']
  return (
    <ol className="steps">
      {steps.map((s, i) => <li key={s} className={i + 1 === current ? 'active' : i + 1 < current ? 'done' : ''}>{s}</li>)}
    </ol>
  )
}

interface McpTool { name: string; raw: string; description: string; readOnly: boolean; source?: 'config' | 'hint' }

/**
 * Bước cuối: đánh dấu tool chỉ đọc. Agent trong cuộc chat chỉ gọi thử (`explore`) được tool chỉ đọc;
 * khi chạy plan thì mọi tool có namespace trong `requires` đều dùng được.
 */
function McpReadOnly({ servers, onClose, onDone }: { servers: AddedServer[]; onClose(): void; onDone(): void }) {
  const [tools, setTools] = useState<Record<string, McpTool[]>>({})
  const [checked, setChecked] = useState<Record<string, Set<string>>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    void Promise.all(servers.map(async (s) => [s.id, await connection.call<McpTool[]>('mcp.tools', { id: s.id })] as const)).then((entries) => {
      setTools(Object.fromEntries(entries))
      setChecked(Object.fromEntries(entries.map(([id, list]) => [id, new Set(list.filter((t) => t.readOnly).map((t) => t.name))])))
    }, (e) => setError((e as Error).message))
  }, [])
  const toggle = (id: string, name: string, on: boolean) => {
    const next = new Set(checked[id])
    if (on) next.add(name)
    else next.delete(name)
    setChecked({ ...checked, [id]: next })
  }
  const save = async () => {
    setBusy(true)
    setError(undefined)
    try {
      for (const s of servers) {
        // Tool server tự đánh dấu chỉ đọc không cần ghi vào cấu hình.
        const configured = (tools[s.id] ?? []).filter((t) => checked[s.id]?.has(t.name) && t.source !== 'hint').map((t) => t.name)
        const before = (tools[s.id] ?? []).filter((t) => t.source === 'config').map((t) => t.name)
        if (configured.sort().join() !== before.sort().join()) await connection.call('mcp.setReadOnly', { id: s.id, tools: configured })
      }
      onDone()
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <>
      <Steps current={3} />
      <div className="ok">✓ Đã thêm {servers.map((s) => <code key={s.id}>{s.id}</code>)}. Tool có hiệu lực ngay, không cần tải lại trang.</div>
      <p className="small">
        Chọn tool <b>chỉ đọc</b> (chỉ lấy dữ liệu, không tạo, sửa, xoá). Agent trong cuộc chat chỉ gọi thử được tool chỉ đọc.
        Khi chạy plan, mọi tool đều dùng được nếu namespace có trong <code>requires</code>.
      </p>
      {servers.map((s) => (
        <div key={s.id} className="mcp-candidate">
          <b>{s.name}</b>
          {!tools[s.id] ? <span className="muted small">Đang tải tool…</span> : !tools[s.id].length ? <span className="warn small">Server không cung cấp tool nào.</span> : (
            <div className="case-checklist">
              {tools[s.id].map((t) => (
                <label key={t.name} title={t.source === 'hint' ? 'Server tự đánh dấu chỉ đọc' : t.description}>
                  <input type="checkbox" disabled={t.source === 'hint'} checked={checked[s.id]?.has(t.name) ?? false} onChange={(e) => toggle(s.id, t.name, e.target.checked)} />
                  <code>{t.name}</code> <span className="muted small">{t.description}{t.source === 'hint' ? ' · server tự đánh dấu' : ''}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      ))}
      <div className="actions">
        <button onClick={onClose}>Bỏ qua</button>
        <button className="primary" disabled={busy} onClick={save}>{busy ? 'Đang lưu…' : 'Lưu và đóng'}</button>
      </div>
      {error && <div className="bad small">{error}</div>}
    </>
  )
}

interface SecretField { key: string; masked: string; envName: string; envSet: boolean; reference: boolean; secret: boolean }
interface McpCandidate {
  name: string; namespace: string; id: string; transport: string; command?: string; args: string[]; url?: string
  env: SecretField[]; headers: SecretField[]; disabled: boolean; warnings: string[]
}
interface ImportResult { name: string; id?: string; ok: boolean; tools?: string[]; error?: string }

/** Dán cấu hình MCP đang dùng ở công cụ khác (Claude, Cursor, Kiro, VS Code), xem trước rồi thêm các server được chọn. */
function PasteMcp({ onAdded }: { onAdded(servers: AddedServer[]): void }) {
  const [text, setText] = useState('')
  const [candidates, setCandidates] = useState<McpCandidate[]>()
  const [choice, setChoice] = useState<Record<string, { on: boolean; namespace: string; useEnv: Record<string, boolean> }>>({})
  const [results, setResults] = useState<ImportResult[]>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const parse = async () => {
    setError(undefined)
    setResults(undefined)
    try {
      const list = await connection.call<McpCandidate[]>('mcp.parse', { text })
      setCandidates(list)
      setChoice(Object.fromEntries(list.map((c) => [c.name, {
        on: !c.disabled,
        namespace: c.namespace,
        useEnv: Object.fromEntries([...c.env, ...c.headers].filter((f) => !f.reference && f.secret).map((f) => [f.key, f.envSet])),
      }])))
    } catch (e) {
      setCandidates(undefined)
      setError((e as Error).message)
    }
  }

  const submit = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const select = Object.entries(choice).filter(([, c]) => c.on).map(([name, c]) => ({ name, namespace: c.namespace, useEnv: c.useEnv }))
      const out = await connection.call<ImportResult[]>('mcp.import', { text, select })
      setResults(out)
      // Có server thêm được và không có lỗi thì sang bước đánh dấu chỉ đọc; có lỗi thì ở lại để người dùng đọc lỗi.
      const ok = out.filter((r) => r.ok && r.id).map((r) => ({ name: r.name, id: r.id! }))
      if (ok.length && ok.length === out.length) onAdded(ok)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const update = (name: string, patch: Partial<(typeof choice)[string]>) => setChoice({ ...choice, [name]: { ...choice[name], ...patch } })
  const selected = Object.values(choice).filter((c) => c.on).length
  return (
    <>
      <Steps current={candidates ? 2 : 1} />
      <textarea
        className="editor small"
        value={text}
        onChange={(e) => { setText(e.target.value); setCandidates(undefined) }}
        placeholder={'Dán nội dung mcp.json, ví dụ:\n{\n  "mcpServers": {\n    "postgres": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-postgres", "${PG_URL}"] }\n  }\n}'}
      />
      {!candidates && <div className="actions"><button className="primary" disabled={!text.trim()} onClick={parse}>Xem trước</button></div>}
      {candidates && <p className="small">Chọn server cần thêm, kiểm tra namespace và giá trị bí mật, rồi bấm <b>Thêm vào aitest</b>.</p>}
      {candidates?.map((c) => {
        const ch = choice[c.name]
        const secrets = [...c.env, ...c.headers]
        return (
          <div key={c.name} className="mcp-candidate">
            <label className="row">
              <input type="checkbox" checked={ch?.on ?? false} onChange={(e) => update(c.name, { on: e.target.checked })} />
              <b>{c.name}</b>
              <span className="muted small">{c.transport === 'stdio' ? `${c.command} ${c.args.join(' ')}` : c.url}</span>
            </label>
            <label className="field"><span className="field-name">Namespace</span>
              <input value={ch?.namespace ?? ''} onChange={(e) => update(c.name, { namespace: e.target.value })} />
            </label>
            {secrets.length > 0 && (
              <div className="small">
                {secrets.map((f) => (
                  <div key={f.key}>
                    <code>{f.key}</code> = <code>{f.masked}</code>{' '}
                    {f.reference ? <span className="muted">(tham chiếu biến môi trường)</span> : !f.secret ? null : (
                      <label>
                        <input
                          type="checkbox"
                          checked={ch?.useEnv[f.key] ?? false}
                          onChange={(e) => update(c.name, { useEnv: { ...ch.useEnv, [f.key]: e.target.checked } })}
                        />
                        {' '}dùng <code>{'${env.' + f.envName + '}'}</code>
                        {f.envSet ? <span className="ok"> (đã đặt trên Host)</span> : <span className="warn"> (chưa đặt; không chọn thì giá trị được ghi vào file patch, không commit)</span>}
                      </label>
                    )}
                  </div>
                ))}
              </div>
            )}
            {c.warnings.map((w) => <div key={w} className="warn small">{w}</div>)}
          </div>
        )
      })}
      {candidates && (
        <div className="actions">
          <button onClick={() => setCandidates(undefined)} disabled={busy}>← Sửa cấu hình</button>
          <button className="primary" disabled={busy || !selected} onClick={submit}>{busy ? 'Đang kết nối…' : `Thêm ${selected} server vào aitest`}</button>
        </div>
      )}
      {results?.map((r) => (
        <div key={r.name} className={r.ok ? 'ok small' : 'bad small'}>
          {r.ok ? `✓ ${r.name} → ${r.id}: ${r.tools?.join(', ') || 'không có tool'}` : `✗ ${r.name}: ${r.error}`}
        </div>
      ))}
      {results && results.some((r) => !r.ok) && results.some((r) => r.ok) && (
        <div className="actions">
          <button className="primary" onClick={() => onAdded(results.filter((r) => r.ok && r.id).map((r) => ({ name: r.name, id: r.id! })))}>
            Tiếp tục với server đã thêm
          </button>
        </div>
      )}
      {error && <div className="bad small">{error}</div>}
    </>
  )
}

function McpForm({ onAdded }: { onAdded(servers: AddedServer[]): void }) {
  const [form, setForm] = useState({
    id: '', namespace: '', transport: 'stdio', command: '', args: '', url: '', prefix: '', include: '',
  })
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value })
  const submit = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await connection.call('mcp.add', {
        id: form.id || `mcp-${form.namespace}`,
        namespace: form.namespace,
        transport: form.transport,
        command: form.transport === 'stdio' ? form.command : undefined,
        args: form.transport === 'stdio' ? form.args.split('\n').map((a) => a.trim()).filter(Boolean) : undefined,
        url: form.transport === 'http' ? form.url : undefined,
        prefix: form.prefix || undefined,
        include: form.include ? form.include.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
      })
      onAdded([{ name: form.namespace, id: form.id || `mcp-${form.namespace}` }])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <label className="field"><span className="field-name">Namespace *</span><input value={form.namespace} onChange={set('namespace')} placeholder="pg, kafka, quote…" /></label>
      <label className="field"><span className="field-name">Mã row</span><input value={form.id} onChange={set('id')} placeholder={`mcp-${form.namespace || '<namespace>'}`} /></label>
      <label className="field">
        <span className="field-name">Transport</span>
        <select value={form.transport} onChange={set('transport')}><option value="stdio">stdio (chạy lệnh)</option><option value="http">HTTP (Streamable HTTP)</option></select>
      </label>
      {form.transport === 'stdio' ? (
        <>
          <label className="field"><span className="field-name">Lệnh *</span><input value={form.command} onChange={set('command')} placeholder="npx, node, uvx…" /></label>
          <label className="field"><span className="field-name">Tham số (mỗi dòng một tham số)</span><textarea className="editor small" value={form.args} onChange={set('args')} placeholder={'-y\n@modelcontextprotocol/server-postgres\npostgres://…'} /></label>
        </>
      ) : (
        <label className="field"><span className="field-name">URL *</span><input value={form.url} onChange={set('url')} placeholder="http://127.0.0.1:3000/mcp" /></label>
      )}
      <label className="field"><span className="field-name">Tiền tố tên action</span><input value={form.prefix} onChange={set('prefix')} placeholder={`${form.namespace || '<namespace>'}_ (để trống dùng mặc định)`} /></label>
      <label className="field"><span className="field-name">Chỉ nhận các tool (cách nhau bởi dấu phẩy)</span><input value={form.include} onChange={set('include')} placeholder="để trống: nhận tất cả" /></label>
      <div className="actions"><button className="primary" disabled={busy || !form.namespace} onClick={submit}>{busy ? 'Đang kết nối…' : 'Thêm vào aitest'}</button></div>
      {error && <div className="bad small">{error}</div>}
    </>
  )
}

function ToolsPage(_: PageProps) {
  const { data: tools, reload } = useRemote<ToolInfo[]>('tools.list')
  const [filter, setFilter] = useState('')
  const groups = useMemo(() => {
    const map = new Map<string, ToolInfo[]>()
    for (const tool of tools ?? []) {
      if (!`${tool.name} ${tool.namespace} ${tool.owner ?? ''} ${tool.description}`.toLowerCase().includes(filter.toLowerCase())) continue
      map.set(tool.namespace, [...(map.get(tool.namespace) ?? []), tool])
    }
    return [...map].sort(([a], [b]) => a.localeCompare(b))
  }, [tools, filter])
  return (
    <main className="manager">
      <header>
        <h2>Tool</h2>
        <input placeholder="Lọc theo tên, namespace, plugin, mô tả…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </header>
      <p className="muted">Tool bị tắt không xuất hiện với agent chạy test lẫn agent soạn plan. Chỉ lời gọi chỉ đọc mới chạy thử được ở đây.</p>
      {groups.map(([namespace, list]) => (
        <section key={namespace} className="tool-group">
          <h3>{namespace} <span className="muted small">{list.length} tool</span></h3>
          {list.map((tool) => <ToolRow key={tool.name} tool={tool} onChange={reload} />)}
        </section>
      ))}
    </main>
  )
}

function ToolRow({ tool, onChange }: { tool: ToolInfo; onChange(): void }) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string>()
  const toggle = async (enabled: boolean) => {
    setError(undefined)
    try {
      await connection.call('tools.setEnabled', { name: tool.name, enabled })
      onChange()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <div className={`tool-row ${tool.enabled ? '' : 'off'}`}>
      <div className="card-head">
        <button className="link" onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} <b>{tool.name}</b></button>
        <span className="muted small">{tool.owner ?? '—'}</span>
        <span className="tags">
          {tool.readOnly && <span className="tag">chỉ đọc</span>}
          {tool.always && <span className="tag">luôn bật</span>}
          {tool.scopes.map((s) => <span key={s} className="tag">{s}</span>)}
        </span>
        <label className="switch">
          <input type="checkbox" role="switch" checked={tool.enabled} onChange={(e) => toggle(e.target.checked)} />
          <span />
        </label>
      </div>
      {open && (
        <div className="tool-detail">
          <p>{tool.description}</p>
          {tool.mcp && tool.owner && <McpReadOnlyToggle tool={tool} owner={tool.owner} onChange={onChange} />}
          <details><summary>Input schema</summary><Json value={tool.inputSchema} /></details>
          {tool.tryable && tool.enabled && <TryTool tool={tool} />}
        </div>
      )}
      {error && <div className="bad small">{error}</div>}
    </div>
  )
}

/** Đánh dấu một tool của MCP server là chỉ đọc, để agent soạn plan gọi thử được qua `explore`. */
function McpReadOnlyToggle({ tool, owner, onChange }: { tool: ToolInfo; owner: string; onChange(): void }) {
  const [list, setList] = useState<McpTool[]>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => { connection.call<McpTool[]>('mcp.tools', { id: owner }).then(setList, (e) => setError((e as Error).message)) }, [owner])
  const self = list?.find((t) => t.name === tool.name)
  const change = async (on: boolean) => {
    setBusy(true)
    setError(undefined)
    try {
      const configured = (list ?? []).filter((t) => t.source === 'config' && t.name !== tool.name).map((t) => t.name)
      await connection.call('mcp.setReadOnly', { id: owner, tools: on ? [...configured, tool.name] : configured })
      onChange()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  if (!self) return error ? <div className="bad small">{error}</div> : null
  return (
    <label className="small" title="Agent soạn plan chỉ gọi thử được tool chỉ đọc">
      <input type="checkbox" checked={self.readOnly} disabled={busy || self.source === 'hint'} onChange={(e) => void change(e.target.checked)} />
      {' '}Chỉ đọc: tool chỉ lấy dữ liệu, agent trong cuộc chat được gọi thử
      {self.source === 'hint' && <span className="muted"> (server tự đánh dấu)</span>}
      {error && <span className="bad"> {error}</span>}
    </label>
  )
}

function TryTool({ tool }: { tool: ToolInfo }) {
  const template = useMemo(() => {
    const props = tool.inputSchema?.properties ?? {}
    const required: string[] = tool.inputSchema?.required ?? []
    return JSON.stringify(Object.fromEntries(required.map((k) => [k, props[k]?.type === 'number' || props[k]?.type === 'integer' ? 0 : ''])), null, 2)
  }, [tool])
  const [args, setArgs] = useState(template)
  const [result, setResult] = useState<unknown>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    setError(undefined)
    setResult(undefined)
    try {
      setResult(await connection.call('tools.try', { name: tool.name, args: JSON.parse(args || '{}') }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="try">
      <div className="field-name">Chạy thử (tham số JSON)</div>
      <textarea className="editor small" spellCheck={false} value={args} onChange={(e) => setArgs(e.target.value)} />
      <div className="actions"><button className="primary" disabled={busy} onClick={run}>{busy ? 'Đang chạy…' : 'Chạy thử'}</button></div>
      {error && <div className="bad small">{error}</div>}
      {result !== undefined && <Json value={result} />}
    </div>
  )
}
