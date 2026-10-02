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
  owner?: string; enabled: boolean; tryable: boolean; inputSchema: any
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

function AddMcp({ onClose, onDone }: { onClose(): void; onDone(): void }) {
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
      <header><h3>Thêm MCP server</h3><button onClick={onClose}>Đóng</button></header>
      <p className="muted small">Tool của server được đăng ký thành action <code>&lt;namespace&gt;_&lt;tool&gt;</code>, đi qua guard, evidence và run log như action nội bộ.</p>
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
      <div className="actions"><button className="primary" disabled={busy || !form.namespace} onClick={submit}>{busy ? 'Đang kết nối…' : 'Thêm MCP server'}</button></div>
      {error && <div className="bad small">{error}</div>}
    </section>
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
          <details><summary>Input schema</summary><Json value={tool.inputSchema} /></details>
          {tool.tryable && tool.enabled && <TryTool tool={tool} />}
        </div>
      )}
      {error && <div className="bad small">{error}</div>}
    </div>
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
