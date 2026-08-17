import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Badge, Button, Card, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, FluentProvider, Input, Select, Spinner, Text, Textarea, Tooltip, webDarkTheme, webLightTheme } from '@fluentui/react-components';
import { Add24Regular, ArrowClockwise24Regular, AppsListDetail24Regular, Bot24Regular, ChartMultiple24Regular, ChevronRight20Regular, CloudArrowUp24Regular, DarkTheme24Regular, Key24Regular, Lightbulb24Regular, People24Regular, Pulse24Regular, Search24Regular, ShieldKeyhole24Regular, Warning24Regular } from '@fluentui/react-icons';
import { guideFor, providerGuides } from './provider-guides';
import * as XLSX from 'xlsx';

type Page = 'overview' | 'accounts' | 'keys' | 'routing' | 'users' | 'analytics' | 'logs' | 'images' | 'test' | 'guide';
type Dashboard = { accounts: number; requests24h: number; failures24h: number; attention: number };
type Account = { id: string; provider: string; name: string; status: string; priority: number; active_leases: number; max_concurrency: number; success_ewma: number; latency_ewma_ms: number | null; last_error?: string };
type Log = { id: string; kind: string; provider?: string; model?: string; status: string; latency_ms?: number; started_at: number; account_name?: string; api_key_name?: string };
type SessionUser = { username: string; role: string };

const providerLabels: Record<string, string> = { chatgpt: 'ChatGPT', kimi: 'Kimi', deepseek: 'DeepSeek', glm: '智谱 GLM', qwen: '通义千问', jimeng: '即梦' };
const statusLabels: Record<string, string> = { ready: '可用', active: '启用', completed: '已完成', failed: '失败', running: '进行中', revoked: '已禁用', action_required: '需处理', refresh_due: '待刷新', refreshing: '刷新中', cooling: '冷却中', disabled: '已停用' };
const roleLabels: Record<string, string> = { owner: '所有者', admin: '管理员', operator: '操作员', auditor: '审计员', user: '调用用户' };
const accountImportColumns = ['provider', 'name', 'priority', ...Array.from(new Set(providerGuides.flatMap((guide) => guide.fields.map((field) => field.key))))];
function labelFor(map: Record<string, string>, value?: string) { return value ? (map[value] ?? value) : '—'; }
function LogoutIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20H10" /><path d="m14 8 4 4-4 4M8 12h10" /></svg>; }
function ImageIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" width="24" height="24"><rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" /></svg>; }
function MenuIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" width="22" height="22"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>; }
function DismissIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" width="20" height="20"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>; }

const nav: Array<{ id: Page; label: string; icon: React.ReactNode }> = [
  { id: 'overview', label: '仪表盘', icon: <Pulse24Regular /> },
  { id: 'accounts', label: '账号池', icon: <People24Regular /> },
  { id: 'keys', label: 'API 密钥', icon: <Key24Regular /> },
  { id: 'routing', label: '模型路由', icon: <AppsListDetail24Regular /> },
  { id: 'users', label: '用户管理', icon: <ShieldKeyhole24Regular /> },
  { id: 'analytics', label: '日志统计', icon: <ChartMultiple24Regular /> },
  { id: 'logs', label: '实时日志', icon: <Search24Regular /> },
  { id: 'images', label: '图片日志', icon: <ImageIcon /> },
  { id: 'test', label: '连接测试', icon: <Bot24Regular /> },
  { id: 'guide', label: '使用指南', icon: <Lightbulb24Regular /> }
];
function pageFromHash(): Page { const page = window.location.hash.slice(1) as Page; return nav.some((item) => item.id === page) ? page : 'overview'; }

const API_BASE = '';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const token = localStorage.getItem('a2a_token');
  const headers = {
    ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...(init?.headers ?? {})
  };
  const response = await fetch(url, { credentials: 'include', headers, ...init });
  if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result.error?.message ?? '请求失败'); }
  return response.json() as Promise<T>;
}

function Metric({ label, value, note, tone = 'default' }: { label: string; value: string | number; note: string; tone?: 'default' | 'warning' | 'danger' }) {
  return <Card className={`metric-card ${tone}`}><Text className="metric-label">{label}</Text><div className="metric-value">{value}</div><Text className="metric-note">{note}</Text></Card>;
}

function Login({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState('owner'); const [password, setPassword] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const res = await api<{ user: { id: string; role: string }; token?: string }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      if (res.token) localStorage.setItem('a2a_token', res.token);
      onSuccess();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '登录失败'); } finally { setBusy(false); }
  }
  return <main className="login-shell"><section className="login-brand"><div className="brand-mark"><Bot24Regular /></div><Text className="brand-overline">Any2API</Text><h1>Control<br />Plane</h1><p>账号授权、模型路由和浏览器运行时的统一控制面。</p><div className="login-status"><span className="status-orb" />本地控制台已就绪</div></section><Card className="login-card"><Text className="eyebrow">安全登录</Text><h2>进入管理台</h2><p>使用初始化 Owner 账号登录。生产环境请通过受信任 HTTPS 域名访问。</p><form onSubmit={submit}><Field label="用户名" required><Input name="username" autoComplete="username" value={username} onChange={(_, data) => setUsername(data.value)} /></Field><Field label="密码" required validationMessage={error}><Input name="password" type="password" autoComplete="current-password" value={password} onChange={(_, data) => setPassword(data.value)} /></Field><Button appearance="primary" type="submit" disabled={busy}>{busy ? <Spinner size="tiny" /> : null}登录控制台</Button></form></Card></main>;
}

function Overview({ dashboard, logs, onPage }: { dashboard: Dashboard | null; logs: Log[]; onPage: (page: Page) => void }) {
  const success = dashboard ? Math.max(0, 100 - dashboard.failures24h / Math.max(dashboard.requests24h, 1) * 100).toFixed(1) : '—';
  return <div className="page-grid"><section className="hero-panel"><div><Text className="eyebrow">运行概览</Text><h1>让每一次模型调用<br />都有迹可循。</h1><p>从账号健康、路由决策到浏览器事件，所有运行信号汇聚到同一条可审计的请求轨迹。</p><Button appearance="primary" icon={<ChevronRight20Regular />} iconPosition="after" onClick={() => onPage('test')}>打开连接测试</Button></div><div className="signal-map" aria-hidden="true"><span className="signal-ring ring-a" /><span className="signal-ring ring-b" /><span className="signal-core" /><span className="signal-label">BROWSER<br />RUNTIME</span></div></section><section className="metrics-grid"><Metric label="已管理账号" value={dashboard?.accounts ?? '—'} note="按渠道隔离凭据与并发" /><Metric label="24 小时调用" value={dashboard?.requests24h ?? '—'} note="包含 API 与连接测试" /><Metric label="成功率" value={`${success}${success === '—' ? '' : '%'}`} note="按已完成请求计算" tone={Number(success) < 95 ? 'warning' : 'default'} /><Metric label="待处理事项" value={dashboard?.attention ?? '—'} note="刷新或人工重新认证" tone={(dashboard?.attention ?? 0) > 0 ? 'danger' : 'default'} /></section><section className="wide-panel request-activity-panel"><div className="section-title"><div><Text className="eyebrow">最新调用</Text><h2>请求活动</h2></div><Button appearance="subtle" onClick={() => onPage('logs')}>查看实时日志</Button></div><RequestTable logs={logs.slice(0, 6)} /></section><section className="attention-panel"><div className="section-title"><div><Text className="eyebrow">运行策略</Text><h2>安全基线</h2></div></div><ul className="policy-list"><li><ShieldKeyhole24Regular /><span><strong>凭据加密</strong>仅在后端运行时解封</span></li><li><Pulse24Regular /><span><strong>账号租约</strong>避免同账号并发争抢</span></li><li><Warning24Regular /><span><strong>异常停用</strong>验证码和登录失效转人工处理</span></li></ul></section></div>;
}

function RequestTable({ logs }: { logs: Log[] }) {
  if (!logs.length) return <div className="empty-state">暂无调用记录。创建 API 密钥后可从 OpenAI SDK 发起第一条请求。</div>;
  return <div className="request-activity-list">{logs.map((log) => <RequestActivityCard key={log.id} log={log} />)}</div>;
}

function RequestActivityCard({ log, selected = false, onSelect }: { log: Log; selected?: boolean; onSelect?: () => void }) {
  const content = <><div className="activity-primary"><span className="activity-provider">{labelFor(providerLabels, log.provider)}</span><strong>{log.model ?? '—'}</strong><Badge appearance="tint" color={log.status === 'completed' ? 'success' : log.status === 'failed' ? 'danger' : 'informative'}>{labelFor(statusLabels, log.status)}</Badge></div><div className="activity-meta"><time dateTime={new Date(log.started_at).toISOString()}><small>发起时间</small><span>{new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(log.started_at)}</span></time><span><small>账号</small><strong>{log.account_name ?? '自动调度'}</strong></span><span><small>API</small><strong>{log.api_key_name ?? (log.kind === 'connection_test' ? '连接测试' : '直连调用')}</strong></span><span><small>耗时</small><strong>{log.latency_ms ? `${log.latency_ms} ms` : '进行中'}</strong></span></div></>;
  const className = `request-activity-card${selected ? ' selected' : ''}`;
  return onSelect ? <button type="button" className={className} onClick={onSelect}>{content}</button> : <article className={className}>{content}</article>;
}

function AccountModal({ open, onClose, onSaved, account }: { open: boolean; onClose: () => void; onSaved: () => void; account?: Account | null }) {
  const [provider, setProvider] = useState(account?.provider ?? 'chatgpt');
  const [name, setName] = useState(account?.name ?? '');
  const [priority, setPriority] = useState(String(account?.priority ?? 50));
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const guide = guideFor(provider);
  useEffect(() => {
    if (!open) return;
    setProvider(account?.provider ?? 'chatgpt');
    setName(account?.name ?? '');
    setPriority(String(account?.priority ?? 50));
    setValues({});
    setError('');
    if (!account) return;
    let current = true;
    void api<Record<string, string>>('/api/accounts/' + account.id + '/credentials').then((credentials) => {
      if (current) setValues(credentials);
    }).catch((reason) => {
      if (current) setError(reason instanceof Error ? reason.message : '无法读取已保存的授权内容');
    });
    return () => { current = false; };
  }, [open, account]);

  function updateProvider(next: string) { if (!account) { setProvider(next); setValues({}); } setError(''); }
  async function save() {
    const credentials = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value));
    if (!name.trim()) { setError('请填写账号名称。'); return; }
    if (!account && !Object.keys(credentials).length) { setError('请至少填写一种授权凭据。'); return; }
    setBusy(true); setError('');
    try {
      if (account) {
        await api('/api/accounts/' + account.id, { method: 'PATCH', body: JSON.stringify({ name: name.trim(), priority: Number(priority) || 50, ...(Object.keys(credentials).length ? { credentials } : {}) }) });
      } else {
        await api('/api/accounts', { method: 'POST', body: JSON.stringify({ provider, name: name.trim(), credentials, priority: Number(priority) || 50 }) });
      }
      onSaved(); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '账号保存失败'); } finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={(_, data) => { if (!data.open) onClose(); }}><DialogSurface className="account-dialog"><DialogBody><DialogTitle>{account ? '编辑账号 · ' + account.name : '添加账号 · ' + guide.name}</DialogTitle><DialogContent><p className="dialog-intro">凭据会以独立字段加密保存。编辑时会明文回显已保存内容，清空凭据字段表示保持原值。</p><div className="dialog-grid"><Field label="渠道"><Select value={provider} disabled={!!account} onChange={(_, data) => updateProvider(data.value)}>{providerGuides.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field><Field label="账号名称" required><Input value={name} onChange={(_, data) => setName(data.value)} placeholder="例如：运营主账号" autoFocus /></Field><Field label="调度优先级"><Input type="number" min="0" max="100" value={priority} onChange={(_, data) => setPriority(data.value)} /></Field></div><div className="credential-callout"><strong>{guide.credentialSummary}</strong><span>{guide.refreshPolicy}</span></div><div className="credential-fields">{guide.fields.map((field) => <Field key={field.key} label={<span>{field.label}{field.preferred ? <Badge appearance="tint" color="success">推荐</Badge> : null}</span>} hint={field.hint}>{field.kind === 'textarea' ? <Textarea name={'credential_' + field.key} autoComplete="off" spellCheck={false} value={values[field.key] ?? ''} onChange={(_, data) => setValues((current) => ({ ...current, [field.key]: data.value }))} resize="vertical" /> : <Input name={'credential_' + field.key} autoComplete="off" spellCheck={false} value={values[field.key] ?? ''} onChange={(_, data) => setValues((current) => ({ ...current, [field.key]: data.value }))} />}</Field>)}</div>{error ? <Text className="form-error">{error}</Text> : null}</DialogContent><DialogActions><Button appearance="secondary" onClick={onClose}>取消</Button><Button appearance="primary" onClick={() => void save()} disabled={busy}>{busy ? <Spinner size="tiny" /> : null}{account ? '保存修改' : '加密保存'}</Button></DialogActions></DialogBody></DialogSurface></Dialog>;
}

function OAuthModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [email, setEmail] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [authUrl, setAuthUrl] = useState('');
  const [codeOrUrl, setCodeOrUrl] = useState('');
  const [accountName, setAccountName] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEmail('');
    setSessionId('');
    setAuthUrl('');
    setCodeOrUrl('');
    setAccountName('');
    setError('');
    setInfo('');
  }, [open]);

  async function startAuth() {
    if (!email.trim()) { setError('请先输入 ChatGPT 账号邮箱。'); return; }
    setStarting(true); setError(''); setInfo('');
    try {
      const res = await api<{ sessionId: string; authorizeUrl: string }>('/api/admin/oauth/start', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim() })
      });
      setSessionId(res.sessionId);
      setAuthUrl(res.authorizeUrl);
      window.open(res.authorizeUrl, '_blank');
      setInfo(`已成功生成授权链接并在新标签页中打开 OpenAI 官方登录窗口 (${email})。登录完成后请复制地址栏完整网址粘贴到步骤 2。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '启动 OAuth 失败');
    } finally {
      setStarting(false);
    }
  }

  async function finishAuth() {
    if (!codeOrUrl.trim()) { setError('请粘贴跳转后的完整 URL 或授权 Code。'); return; }
    setBusy(true); setError(''); setInfo('');
    try {
      await api('/api/admin/oauth/finish', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: sessionId || undefined,
          callback: codeOrUrl.trim(),
          accountName: accountName.trim() || (email.trim() ? `ChatGPT (${email.trim()})` : undefined)
        })
      });
      onSaved(); onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'OAuth 授权完成失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(_, data) => { if (!data.open) onClose(); }}>
      <DialogSurface className="compact-dialog" style={{ width: 'min(580px, calc(100vw - 32px))' }}>
        <DialogBody>
          <DialogTitle>ChatGPT OAuth 一键授权登录</DialogTitle>
          <DialogContent style={{ display: 'flex', flexDirection: 'column', gap: '20px', paddingTop: '12px' }}>
            <p className="dialog-intro" style={{ margin: 0 }}>
              通过 OpenAI 官方 OAuth 授权免密码登录，自动向官方服务换取 Access Token 与 Refresh Token。
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px 16px', background: 'var(--a2a-bg-card, rgba(255, 255, 255, 0.04))', border: '1px solid rgba(128, 128, 128, 0.2)', borderRadius: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ fontWeight: 600, fontSize: '14px' }}>1. 输入账号邮箱并生成授权页面</Text>
                <Badge appearance="tint" color="informative">步骤 1</Badge>
              </div>
              <Field label="ChatGPT 账号邮箱" required hint="输入的邮箱会自动带入 OpenAI 官方登录提示">
                <Input
                  value={email}
                  onChange={(_, data) => setEmail(data.value)}
                  placeholder="例如：user@example.com"
                  style={{ width: '100%' }}
                  autoFocus
                />
              </Field>
              <Button
                appearance="primary"
                disabled={starting || !email.trim()}
                onClick={() => void startAuth()}
                style={{ backgroundColor: '#10a37f', color: '#fff', fontWeight: 600, marginTop: '4px', height: '36px' }}
              >
                {starting ? <Spinner size="tiny" /> : '生成并打开 OpenAI 授权页面 ↗'}
              </Button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <Field
                label={<span style={{ fontWeight: 600, fontSize: '14px' }}>2. 粘贴回调 URL 或 Code（必填）</span>}
                hint="登录成功后，复制浏览器地址栏以 https://platform.openai.com/auth/callback?code=... 开头的完整网址并粘贴到下方："
              >
                <Textarea
                  value={codeOrUrl}
                  onChange={(_, data) => setCodeOrUrl(data.value)}
                  placeholder="https://platform.openai.com/auth/callback?code=..."
                  rows={3}
                  style={{ width: '100%', fontFamily: 'monospace', fontSize: '12px' }}
                />
              </Field>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <Field
                label={<span style={{ fontWeight: 600, fontSize: '14px' }}>3. 账号识别别名（可选）</span>}
                hint={email.trim() ? `默认名称：ChatGPT (${email.trim()})` : '自定义此账号在控制台账号池中的识别名字'}
              >
                <Input
                  value={accountName}
                  onChange={(_, data) => setAccountName(data.value)}
                  placeholder={email.trim() ? `ChatGPT (${email.trim()})` : '例如：ChatGPT 团队主账号'}
                  style={{ width: '100%' }}
                />
              </Field>
            </div>

            {info ? <Text style={{ color: '#10a37f', fontSize: '12px', lineHeight: '1.5', margin: 0 }}>{info}</Text> : null}
            {error ? <Text className="form-error" style={{ margin: 0 }}>{error}</Text> : null}
          </DialogContent>
          <DialogActions style={{ marginTop: '12px' }}>
            <Button appearance="secondary" onClick={onClose}>取消</Button>
            <Button appearance="primary" onClick={() => void finishAuth()} disabled={busy}>
              {busy ? <Spinner size="tiny" /> : null}完成授权并加密保存账号
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function AccountPoolPage({ accounts, refresh }: { accounts: Account[]; refresh: () => void }) {
  type ImportAccount = { provider: string; name: string; priority: number; credentials: Record<string, string> };
  const [open, setOpen] = useState(false);
  const [oauthOpen, setOauthOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [testing, setTesting] = useState('');
  const [result, setResult] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);
  const [importRows, setImportRows] = useState<ImportAccount[]>([]);
  const [importFileName, setImportFileName] = useState('');
  const importFileRef = useRef<HTMLInputElement>(null);
  async function test(account: Account) { setTesting(account.id); setResult(''); try { const outcome = await api<{ ok: boolean; detail: string }>('/api/accounts/' + account.id + '/test', { method: 'POST' }); setResult(account.name + '：' + (outcome.ok ? '验证通过' : '验证失败') + ' — ' + outcome.detail); refresh(); } catch (reason) { setResult(reason instanceof Error ? reason.message : '验证请求失败'); } finally { setTesting(''); } }
  const columnWidths = (columns: string[]) => columns.map((column) => ({ wch: Math.max(14, Math.min(30, column.length + 8)) }));
  function downloadWorkbook(workbook: XLSX.WorkBook, fileName: string) { XLSX.writeFile(workbook, fileName, { compression: true }); }
  function downloadTemplate() {
    const workbook = XLSX.utils.book_new();
    const accountSheet = XLSX.utils.json_to_sheet([], { header: accountImportColumns });
    accountSheet['!cols'] = columnWidths(accountImportColumns);
    const notes = providerGuides.flatMap((guide) => guide.fields.map((field) => ({ 渠道: guide.name, 字段: field.key, 说明: `${field.label}：${field.hint}` })));
    const noteSheet = XLSX.utils.json_to_sheet(notes, { header: ['渠道', '字段', '说明'] });
    noteSheet['!cols'] = [{ wch: 16 }, { wch: 22 }, { wch: 72 }];
    XLSX.utils.book_append_sheet(workbook, accountSheet, '账号');
    XLSX.utils.book_append_sheet(workbook, noteSheet, '字段说明');
    downloadWorkbook(workbook, 'any2api-账号导入模板.xlsx');
  }
  async function exportAccounts() {
    try {
      const payload = await api<{ version: number; accounts: Array<ImportAccount> }>('/api/accounts/export');
      const columns = Array.from(new Set([...accountImportColumns, ...payload.accounts.flatMap((account) => Object.keys(account.credentials ?? {}))]));
      const rows = payload.accounts.map((account) => Object.fromEntries(columns.map((column) => [column, column === 'provider' ? account.provider : column === 'name' ? account.name : column === 'priority' ? account.priority : account.credentials?.[column] ?? ''])));
      const workbook = XLSX.utils.book_new();
      const sheet = XLSX.utils.json_to_sheet(rows, { header: columns });
      sheet['!cols'] = columnWidths(columns);
      XLSX.utils.book_append_sheet(workbook, sheet, '账号');
      downloadWorkbook(workbook, 'any2api-accounts.xlsx');
      setResult(`已导出 ${payload.accounts.length} 个账号。`);
    } catch (reason) { setResult(reason instanceof Error ? reason.message : '账号导出失败'); }
  }
  async function selectImportFile(file?: File) {
    if (!file) return;
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(firstSheet, { defval: '' });
      const parsed = rawRows.map((row): ImportAccount => {
        const credentials = Object.fromEntries(Object.entries(row).filter(([key, value]) => !['provider', 'name', 'priority'].includes(key) && String(value).trim()).map(([key, value]) => [key, String(value).trim()]));
        return { provider: String(row.provider ?? '').trim(), name: String(row.name ?? '').trim(), priority: Number(row.priority) || 50, credentials };
      }).filter((row) => row.provider || row.name || Object.keys(row.credentials).length);
      if (!parsed.length) throw new Error('Excel 首个工作表未发现可导入的账号。');
      setImportRows(parsed); setImportFileName(file.name); setImportError('');
    } catch (reason) { setImportRows([]); setImportFileName(''); setImportError(reason instanceof Error ? reason.message : 'Excel 文件读取失败'); }
  }
  async function importAccounts() { try { if (!importRows.length) throw new Error('请先选择包含账号数据的 Excel 文件。'); setImporting(true); setImportError(''); const outcome = await api<{ imported: number }>('/api/accounts/import', { method: 'POST', body: JSON.stringify({ accounts: importRows }) }); setResult(`已导入 ${outcome.imported} 个账号。`); setImportRows([]); setImportFileName(''); setImportOpen(false); refresh(); } catch (reason) { setImportError(reason instanceof Error ? reason.message : '账号导入失败'); } finally { setImporting(false); } }
  async function remove(account: Account) {
    if (!window.confirm(`确定删除账号“${account.name}”？删除后将解除该账号的绝密凭据保存且无法恢复。`)) return;
    try {
      setResult('');
      await api('/api/accounts/' + account.id, { method: 'DELETE' });
      setResult(`已删除账号“${account.name}”。`);
      refresh();
    } catch (reason) { setResult(reason instanceof Error ? reason.message : '删除账号失败'); }
  }
  return <section className="module-page">
    <div className="section-title"><div><Text className="eyebrow">资源管理</Text><h1>账号池</h1><p>保存加密凭据后账号立即进入调度池；诊断仅用于你需要主动排障时查看渠道反馈。</p></div><div className="page-actions"><Button appearance="secondary" onClick={() => void exportAccounts()}>导出 Excel</Button><Button appearance="secondary" onClick={() => { setImportError(''); setImportRows([]); setImportFileName(''); setImportOpen(true); }}>批量导入</Button><Button appearance="secondary" onClick={() => setOauthOpen(true)}>ChatGPT OAuth 授权</Button><Button appearance="primary" icon={<Add24Regular />} onClick={() => { setEditing(null); setOpen(true); }}>添加账号</Button></div></div>
    <div className="account-summary"><Card><strong>{accounts.length}</strong><span>已纳管账号</span></Card><Card><strong>{accounts.filter((account) => account.status === 'ready').length}</strong><span>可调度账号</span></Card><Card><strong>{accounts.filter((account) => account.status === 'action_required').length}</strong><span>待处理账号</span></Card></div>
    {result ? <Text className="account-test-result">{result}</Text> : null}
    <Card className="table-card"><div className="account-table"><div className="data-head"><span>账号</span><span>渠道</span><span>状态</span><span>健康度</span><span>并发</span><span>优先级</span><span>操作</span></div>{accounts.length ? accounts.map((account) => <div className="data-row" key={account.id}><span className="account-name"><span className="provider-tile">{account.provider.slice(0, 1).toUpperCase()}</span><span><strong>{account.name}</strong><small>{providerLabels[account.provider] ?? account.provider}</small></span></span><span>{labelFor(providerLabels, account.provider)}</span><Badge appearance="tint" color={account.status === 'ready' ? 'success' : account.status === 'action_required' ? 'warning' : 'informative'}>{labelFor(statusLabels, account.status)}</Badge><span>{Math.round(account.success_ewma * 100)}% <small>成功率</small></span><span>{account.active_leases} / {account.max_concurrency}</span><span>{account.priority}</span><span className="row-actions"><Button appearance="subtle" size="small" onClick={() => { setEditing(account); setOpen(true); }}>编辑</Button><Button appearance="subtle" size="small" onClick={() => void test(account)} disabled={testing === account.id}>{testing === account.id ? '诊断中…' : '诊断'}</Button><Button appearance="subtle" size="small" onClick={() => void remove(account)}>删除</Button></span></div>) : <div className="empty-state">尚未配置任何账号。点击“添加账号”，按渠道录入授权材料后即可调度。</div>}</div></Card>
    <AccountModal open={open} account={editing} onClose={() => { setOpen(false); setEditing(null); }} onSaved={refresh} />
    <OAuthModal open={oauthOpen} onClose={() => setOauthOpen(false)} onSaved={refresh} />
    <Dialog open={importOpen} onOpenChange={(_, data) => { if (!data.open) setImportOpen(false); }}><DialogSurface className="compact-dialog"><DialogBody><DialogTitle>批量导入账号</DialogTitle><DialogContent><p className="dialog-intro">选择符合模板的 Excel 文件（.xlsx / .xls）。相同渠道与账号名称会更新凭据和优先级。</p><input ref={importFileRef} className="visually-hidden" type="file" accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange={(event) => void selectImportFile(event.target.files?.[0])} /><div className="import-file-actions"><Button appearance="secondary" icon={<CloudArrowUp24Regular />} onClick={() => importFileRef.current?.click()}>选择 Excel 文件</Button><Button appearance="subtle" onClick={downloadTemplate}>下载模板</Button></div><Text className="import-file-name">{importFileName ? `已选择：${importFileName}（${importRows.length} 条账号）` : '尚未选择文件'}</Text>{importError ? <Text className="form-error">{importError}</Text> : null}</DialogContent><DialogActions><Button appearance="secondary" onClick={() => setImportOpen(false)}>取消</Button><Button appearance="primary" onClick={() => void importAccounts()} disabled={importing}>{importing ? <Spinner size="tiny" /> : null}导入账号</Button></DialogActions></DialogBody></DialogSurface></Dialog>
  </section>;
}


function GuidePage() {
  const [provider, setProvider] = useState('chatgpt'); const guide = guideFor(provider);
  return <section className="module-page guide-page"><div className="section-title"><div><Text className="eyebrow">授权与排障</Text><h1>使用指南</h1><p>仅录入你本人有权使用的账户凭据。凭据默认加密保存，日志与连接测试会自动脱敏。</p></div></div><div className="guide-layout"><aside className="guide-tabs" aria-label="渠道获取凭据指南">{providerGuides.map((item) => <button key={item.id} className={provider === item.id ? 'active' : ''} onClick={() => setProvider(item.id)}><span>{item.name}</span><ChevronRight20Regular /></button>)}</aside><Card className="guide-content"><div className="guide-heading"><div><Text className="eyebrow">{guide.name}</Text><h2>{guide.credentialSummary}</h2></div><a href={guide.loginUrl} target="_blank" rel="noreferrer">打开官方站点</a></div><div className="guide-meta"><span>授权材料：{guide.fields.map((field) => field.label).join(' / ')}</span><span>刷新策略：{guide.refreshPolicy}</span></div><ol className="guide-steps">{guide.steps.map((step) => <li key={step}>{step}</li>)}</ol><div className="guide-warning"><Warning24Regular /><span>{guide.warning}</span></div><div className="guide-footer"><strong>录入后下一步</strong><span>前往账号池保存凭据，随后在连接测试中选择该账号查看完整、脱敏的运行事件。</span></div></Card></div></section>;
}

function KeysPage() {
  type KeyItem = { id: string; name: string; key_prefix: string; role: string; status: string; last_used_at?: number };
  const [items, setItems] = useState<KeyItem[]>([]); const [open, setOpen] = useState(false); const [name, setName] = useState(''); const [role, setRole] = useState('user'); const [created, setCreated] = useState(''); const [error, setError] = useState(''); const [actionError, setActionError] = useState(''); const [copied, setCopied] = useState(''); const [busy, setBusy] = useState(false);
  const load = () => api<KeyItem[]>('/api/keys').then(setItems);
  useEffect(() => { void load(); }, []);
  function close() { setOpen(false); setName(''); setRole('user'); setError(''); }
  async function copy(value: string, id: string) { try { const fullValue = id === 'created' ? value : (await api<{ value: string }>('/api/keys/' + id + '/value')).value; await navigator.clipboard.writeText(fullValue); setCopied(id); window.setTimeout(() => setCopied((current) => current === id ? '' : current), 1600); } catch (reason) { setActionError(reason instanceof Error ? reason.message : '复制失败，请手动复制该密钥。'); } }
  async function create() { if (!name.trim()) { setError('请填写密钥名称。'); return; } setBusy(true); setError(''); try { const result = await api<{ value: string }>('/api/keys', { method: 'POST', body: JSON.stringify({ name: name.trim(), role }) }); setCreated(result.value); void load(); } catch (reason) { setError(reason instanceof Error ? reason.message : '创建密钥失败'); } finally { setBusy(false); } }
  async function toggle(item: KeyItem) { try { setActionError(''); await api('/api/keys/' + item.id, { method: 'PATCH', body: JSON.stringify({ status: item.status === 'active' ? 'revoked' : 'active' }) }); void load(); } catch (reason) { setActionError(reason instanceof Error ? reason.message : '更新密钥状态失败'); } }
  async function remove(item: KeyItem) { if (!window.confirm(`确定删除 API 密钥“${item.name}”？删除后无法恢复。`)) return; try { setActionError(''); await api('/api/keys/' + item.id, { method: 'DELETE' }); void load(); } catch (reason) { setActionError(reason instanceof Error ? reason.message : '删除密钥失败'); } }
  return <section className="module-page"><div className="section-title"><div><h1>API 密钥</h1><p>密钥只在创建时显示完整值。请将其保存到调用方的安全环境变量中。</p></div><Button appearance="primary" icon={<Add24Regular />} onClick={() => { setCreated(''); setOpen(true); }}>创建密钥</Button></div>{created ? <Card className="key-reveal-panel"><strong>新密钥已生成，请立即保存：</strong><code>{created}</code><span className="key-reveal-actions"><Button appearance="secondary" size="small" onClick={() => void copy(created, 'created')}>{copied === 'created' ? '已复制' : '复制 Key'}</Button><Button appearance="subtle" size="small" onClick={() => setCreated('')}>我已保存</Button></span></Card> : null}{actionError ? <Text className="form-error">{actionError}</Text> : null}<Card className="table-card"><div className="data-table key-table"><div className="data-head"><span>名称</span><span>前缀</span><span>角色</span><span>最近使用</span><span>状态</span><span>操作</span></div>{items.map((item) => <div className="data-row" key={item.id}><span>{item.name}</span><span className="key-prefix"><code>{item.key_prefix}…</code><Tooltip content="复制密钥前缀" relationship="label"><Button appearance="subtle" size="small" className="key-copy-button" aria-label={`复制 ${item.name} 的密钥前缀`} onClick={() => void copy(item.key_prefix, item.id)}>{copied === item.id ? '已复制' : '复制'}</Button></Tooltip></span><span>{labelFor(roleLabels, item.role)}</span><span>{item.last_used_at ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(item.last_used_at) : '从未使用'}</span><span><Badge appearance="tint" color={item.status === 'active' ? 'success' : 'warning'}>{labelFor(statusLabels, item.status)}</Badge></span><span className="key-actions"><Button appearance="subtle" size="small" onClick={() => void toggle(item)}>{item.status === 'active' ? '禁用' : '启用'}</Button><Button appearance="subtle" size="small" onClick={() => void remove(item)}>删除</Button></span></div>)}</div></Card><Dialog open={open} onOpenChange={(_, data) => { if (!data.open) close(); }}><DialogSurface className="compact-dialog"><DialogBody><DialogTitle>创建 API 密钥</DialogTitle><DialogContent><p className="dialog-intro">为调用方填写基本信息，密钥只会展示一次。</p><div className="dialog-grid"><Field label="密钥名称" required><Input value={name} onChange={(_, data) => setName(data.value)} placeholder="例如：生产服务" autoFocus /></Field><Field label="调用角色"><Select value={role} onChange={(_, data) => setRole(data.value)}><option value="user">调用用户</option><option value="operator">操作员</option></Select></Field></div>{error ? <Text className="form-error">{error}</Text> : null}{created ? <div className="key-reveal"><strong>请立即保存完整密钥：</strong><code>{created}</code><Button appearance="secondary" size="small" onClick={() => void copy(created, 'created')}>{copied === 'created' ? '已复制' : '复制 Key'}</Button></div> : null}</DialogContent><DialogActions>{created ? <Button appearance="primary" onClick={close}>完成</Button> : <><Button appearance="secondary" onClick={close}>取消</Button><Button appearance="primary" onClick={() => void create()} disabled={busy}>{busy ? <Spinner size="tiny" /> : null}生成 API Key</Button></>}</DialogActions></DialogBody></DialogSurface></Dialog></section>;
}


function ModelTags({ raw }: { raw: string }) {
  const value = JSON.parse(raw) as { input: string[]; output: string[]; reasoningSummary?: boolean; webSearch?: boolean; imageGeneration?: boolean };
  const isImageGen = value.imageGeneration || value.output.includes('image');
  const isVideoGen = value.output.includes('video');
  const isTextOut = value.output.includes('text');

  const labels = [
    isTextOut ? '文本' : '',
    value.reasoningSummary ? '思考' : '',
    value.webSearch ? '搜索' : '',
    value.input.includes('image') ? '视觉' : '',
    isImageGen ? '生图' : '',
    isVideoGen ? '生视频' : ''
  ].filter(Boolean);

  return <span className="model-tags">{labels.map((label) => <small key={label}>{label}</small>)}</span>;
}

function RoutesPage() {
  type RouteItem = { id: string; public_model: string; provider: string; upstream_id: string; capabilities_json: string; enabled: number; priority: number };
  const [items, setItems] = useState<RouteItem[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<RouteItem | null>(null);
  const [publicModel, setPublicModel] = useState('');
  const [provider, setProvider] = useState('chatgpt');
  const [upstreamModel, setUpstreamModel] = useState('');
  const [priority, setPriority] = useState('50');
  const [enabled, setEnabled] = useState('true');
  const [error, setError] = useState('');
  const load = () => api<RouteItem[]>('/api/routes').then(setItems);
  useEffect(() => { void load(); }, []);
  function reset() { setEditing(null); setPublicModel(''); setProvider('chatgpt'); setUpstreamModel(''); setPriority('50'); setEnabled('true'); setError(''); }
  function openEdit(item: RouteItem) { setEditing(item); setPublicModel(item.public_model); setProvider(item.provider); setUpstreamModel(item.upstream_id); setPriority(String(item.priority)); setEnabled(item.enabled ? 'true' : 'false'); setError(''); setOpen(true); }
  async function save() {
    if (!publicModel.trim() || !upstreamModel.trim()) { setError('请填写公开模型名和上游模型名。'); return; }
    try {
      const body = { publicModel: publicModel.trim(), provider, upstreamModel: upstreamModel.trim(), priority: Number(priority) || 50, enabled: enabled === 'true' };
      await api(editing ? '/api/routes/' + editing.id : '/api/routes', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      setOpen(false); reset(); void load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存路由失败'); }
  }
  return <section className="module-page"><div className="section-title"><div><Text className="eyebrow">模型编排</Text><h1>模型路由</h1><p>已预置各官网网页端模型；通过路由统一控制公开模型名、上游模型和优先级。</p></div><Button appearance="primary" icon={<Add24Regular />} onClick={() => { reset(); setOpen(true); }}>新增路由</Button></div><Card className="table-card"><div className="data-table route-table"><div className="data-head"><span>公开模型</span><span>渠道</span><span>上游模型</span><span>能力</span><span>优先级</span><span>状态</span><span>操作</span></div>{items.map((item) => <div className="data-row" key={item.id}><code>{item.public_model}</code><span>{labelFor(providerLabels, item.provider)}</span><span>{item.upstream_id}</span><ModelTags raw={item.capabilities_json} /><span>{item.priority}</span><Badge appearance="tint" color={item.enabled ? 'success' : 'warning'}>{item.enabled ? '已启用' : '已停用'}</Badge><Button appearance="subtle" onClick={() => openEdit(item)}>编辑</Button></div>)}</div></Card><Dialog open={open} onOpenChange={(_, data) => { if (!data.open) { setOpen(false); reset(); } }}><DialogSurface className="compact-dialog"><DialogBody><DialogTitle>{editing ? '编辑模型路由' : '新增模型路由'}</DialogTitle><DialogContent><p className="dialog-intro">公开模型名用于 OpenAI 兼容调用，上游模型名对应实际渠道模型。</p><div className="dialog-grid route-dialog-grid"><Field label="公开模型名" required><Input value={publicModel} onChange={(_, data) => setPublicModel(data.value)} placeholder="例如：team-reasoning" autoFocus /></Field><Field label="渠道" required><Select value={provider} onChange={(_, data) => setProvider(data.value)}>{providerGuides.map((guide) => <option key={guide.id} value={guide.id}>{guide.name}</option>)}</Select></Field><Field label="上游模型名" required><Input value={upstreamModel} onChange={(_, data) => setUpstreamModel(data.value)} placeholder="例如：gpt-5.4-thinking" /></Field><Field label="优先级"><Input type="number" min="0" max="100" value={priority} onChange={(_, data) => setPriority(data.value)} /></Field><Field label="状态"><Select value={enabled} onChange={(_, data) => setEnabled(data.value)}><option value="true">已启用</option><option value="false">已停用</option></Select></Field></div>{error ? <Text className="form-error">{error}</Text> : null}</DialogContent><DialogActions><Button appearance="secondary" onClick={() => { setOpen(false); reset(); }}>取消</Button><Button appearance="primary" onClick={() => void save()}>保存路由</Button></DialogActions></DialogBody></DialogSurface></Dialog></section>;
}


function UsersPage() {
  type User = { id: string; username: string; role: string; created_at: number };
  const [items, setItems] = useState<User[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('operator');
  const [error, setError] = useState('');
  const load = () => api<User[]>('/api/users').then(setItems);
  useEffect(() => { void load(); }, []);
  function reset() { setOpen(false); setEditing(null); setUsername(''); setPassword(''); setRole('operator'); setError(''); }
  function openCreate() { reset(); setOpen(true); }
  function openEdit(user: User) { setEditing(user); setUsername(user.username); setPassword(''); setRole(user.role); setError(''); setOpen(true); }
  async function save() {
    try {
      setError('');
      if (editing) {
        const body = { ...(password ? { password } : {}), ...(role !== editing.role ? { role } : {}) };
        await api('/api/users/' + editing.id, { method: 'PATCH', body: JSON.stringify(body) });
      } else {
        if (!username.trim() || password.length < 4) { setError('请输入用户名，密码至少 4 个字符。'); return; }
        await api('/api/users', { method: 'POST', body: JSON.stringify({ username: username.trim(), password, role }) });
      }
      reset(); void load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存用户失败'); }
  }
  return <section className="module-page"><div className="section-title"><div><Text className="eyebrow">身份治理</Text><h1>用户管理</h1><p>不提供注册页。管理员在这里创建、调整和审计控制台用户。</p></div><Button appearance="primary" icon={<Add24Regular />} onClick={openCreate}>创建用户</Button></div><Card className="table-card"><div className="data-table users-table"><div className="data-head"><span>用户</span><span>角色</span><span>创建时间</span><span>状态</span><span>操作</span></div>{items.map((item) => <div className="data-row" key={item.id}><span>{item.username}</span><Badge appearance="tint">{labelFor(roleLabels, item.role)}</Badge><span>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short' }).format(item.created_at)}</span><Badge appearance="tint" color="success">{labelFor(statusLabels, 'active')}</Badge><Button appearance="subtle" disabled={item.role === 'owner'} onClick={() => openEdit(item)}>{item.role === 'owner' ? '受保护' : '编辑'}</Button></div>)}</div></Card><Dialog open={open} onOpenChange={(_, data) => { if (!data.open) reset(); }}><DialogSurface className="compact-dialog"><DialogBody><DialogTitle>{editing ? '编辑用户 · ' + editing.username : '创建用户'}</DialogTitle><DialogContent><p className="dialog-intro">{editing ? '可更新角色或重置密码。留空密码表示保持不变。' : '创建后用户可直接登录控制台，密码至少 4 个字符。'}</p><div className="dialog-grid"><Field label="用户名" required><Input value={username} disabled={!!editing} onChange={(_, data) => setUsername(data.value)} autoFocus /></Field><Field label={editing ? '新密码' : '初始密码'} required={!editing}><Input type="password" autoComplete="new-password" value={password} onChange={(_, data) => setPassword(data.value)} placeholder={editing ? '留空以保持不变' : '至少 4 个字符'} /></Field><Field label="角色"><Select value={role} onChange={(_, data) => setRole(data.value)}><option value="admin">管理员</option><option value="operator">操作员</option><option value="auditor">审计员</option></Select></Field></div>{error ? <Text className="form-error">{error}</Text> : null}</DialogContent><DialogActions><Button appearance="secondary" onClick={reset}>取消</Button><Button appearance="primary" onClick={() => void save()}>{editing ? '保存修改' : '创建用户'}</Button></DialogActions></DialogBody></DialogSurface></Dialog></section>;
}


type AnalyticsSummary = {
  requests: number;
  completed: number;
  failed: number;
  success_rate: number;
  avg_latency: number;
  min_latency: number;
  max_latency: number;
  p95_latency: number;
  image_count: number;
  active_keys: number;
  active_accounts: number;
};

type TimeSeriesPoint = {
  time: string;
  timestamp: number;
  requests: number;
  completed: number;
  failed: number;
  success_rate: number;
  avg_latency: number;
};

type ProviderStat = {
  provider: string;
  requests: number;
  completed: number;
  failed: number;
  success_rate: number;
  avg_latency: number;
};

type ApiKeyStat = {
  api_key_id: string | null;
  key_name: string;
  key_prefix: string;
  role: string;
  last_used_at: number | null;
  requests: number;
  completed: number;
  failed: number;
  success_rate: number;
  avg_latency: number;
};

type AccountStat = {
  account_id: string | null;
  account_name: string;
  provider: string;
  priority: number;
  status: string;
  requests: number;
  completed: number;
  failed: number;
  success_rate: number;
  avg_latency: number;
};

type ModelStat = {
  model: string;
  provider: string;
  requests: number;
  completed: number;
  failed: number;
  success_rate: number;
  avg_latency: number;
};

type AnalyticsData = {
  timeRange: string;
  startTime: number;
  endTime: number;
  summary: AnalyticsSummary;
  timeSeries: TimeSeriesPoint[];
  byProvider: ProviderStat[];
  byApiKey: ApiKeyStat[];
  byAccount: AccountStat[];
  byModel: ModelStat[];
  filterOptions: {
    providers: string[];
    apiKeys: Array<{ id: string; name: string; key_prefix: string }>;
    accounts: Array<{ id: string; name: string; provider: string }>;
    models: Array<{ id: string; provider: string }>;
  };
};

type SearchLogItem = {
  id: string;
  kind: string;
  provider: string | null;
  model: string | null;
  status: string;
  http_status: number | null;
  latency_ms: number | null;
  started_at: number;
  completed_at: number | null;
  account_id: string | null;
  account_name: string | null;
  api_key_id: string | null;
  api_key_name: string | null;
  key_prefix: string | null;
  prompt_preview: string;
  reply_preview: string;
  events_count: number;
  has_images: boolean;
};

type LogDetailData = {
  log: any;
  events: AuditEvent[];
  promptMessages: Array<{ role?: string; content?: any }>;
  assistantReply: string;
  reasoning: string;
  citations: any[];
  images: string[];
  failureError: string;
};

function resolveImgUrl(url?: string | null) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) return url;
  return `${API_BASE}${url.startsWith('/') ? '' : '/'}${url}`;
}

function formatMs(ms?: number | null) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function AnalyticsPage() {
  const [timeRange, setTimeRange] = useState<string>('7d');
  const [customStart, setCustomStart] = useState<string>('');
  const [customEnd, setCustomEnd] = useState<string>('');
  const [provider, setProvider] = useState<string>('all');
  const [apiKeyId, setApiKeyId] = useState<string>('all');
  const [accountId, setAccountId] = useState<string>('all');
  const [model, setModel] = useState<string>('all');
  const [status, setStatus] = useState<string>('all');
  const [keyword, setKeyword] = useState<string>('');

  const [activeTab, setActiveTab] = useState<'provider' | 'apiKey' | 'account' | 'model' | 'logs'>('provider');
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const [logs, setLogs] = useState<SearchLogItem[]>([]);
  const [totalLogs, setTotalLogs] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
  const [loadingLogs, setLoadingLogs] = useState<boolean>(false);

  const [inspectLogId, setInspectLogId] = useState<string | null>(null);
  const [inspectDetail, setInspectDetail] = useState<LogDetailData | null>(null);
  const [inspectLoading, setInspectLoading] = useState<boolean>(false);

  const buildQueryString = useCallback((extra: Record<string, string | number> = {}) => {
    const params = new URLSearchParams();
    params.set('timeRange', timeRange);
    if (timeRange === 'custom') {
      if (customStart) params.set('startTime', String(new Date(customStart).getTime()));
      if (customEnd) params.set('endTime', String(new Date(customEnd).getTime()));
    }
    if (provider !== 'all') params.set('provider', provider);
    if (apiKeyId !== 'all') params.set('apiKeyId', apiKeyId);
    if (accountId !== 'all') params.set('accountId', accountId);
    if (model !== 'all') params.set('model', model);
    if (status !== 'all') params.set('status', status);
    if (keyword.trim()) params.set('keyword', keyword.trim());

    Object.entries(extra).forEach(([k, v]) => params.set(k, String(v)));
    return params.toString();
  }, [timeRange, customStart, customEnd, provider, apiKeyId, accountId, model, status, keyword]);

  const loadAnalytics = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<AnalyticsData>(`/api/analytics?${buildQueryString()}`);
      setData(res);
    } catch (e) {
      console.error('Failed to load analytics:', e);
    } finally {
      setLoading(false);
    }
  }, [buildQueryString]);

  const loadLogs = useCallback(async (targetPage = page) => {
    setLoadingLogs(true);
    try {
      const res = await api<{ total: number; page: number; limit: number; items: SearchLogItem[] }>(
        `/api/logs/search?${buildQueryString({ page: targetPage, limit: 20 })}`
      );
      setLogs(res.items);
      setTotalLogs(res.total);
      setPage(res.page);
    } catch (e) {
      console.error('Failed to load logs:', e);
    } finally {
      setLoadingLogs(false);
    }
  }, [buildQueryString, page]);

  useEffect(() => {
    void loadAnalytics();
    void loadLogs(1);
  }, [loadAnalytics, loadLogs]);

  const openLogDetail = async (id: string) => {
    setInspectLogId(id);
    setInspectLoading(true);
    try {
      const detail = await api<LogDetailData>(`/api/logs/${id}/detail`);
      setInspectDetail(detail);
    } catch (e) {
      console.error('Failed to load log detail:', e);
    } finally {
      setInspectLoading(false);
    }
  };

  const resetFilters = () => {
    setTimeRange('7d');
    setCustomStart('');
    setCustomEnd('');
    setProvider('all');
    setApiKeyId('all');
    setAccountId('all');
    setModel('all');
    setStatus('all');
    setKeyword('');
    setPage(1);
  };

  const summary = data?.summary;
  const timeSeries = data?.timeSeries ?? [];
  const maxReqInSeries = Math.max(1, ...timeSeries.map((t) => t.requests));

  return (
    <section className="module-page analytics-page">
      <div className="section-title">
        <div>
          <Text className="eyebrow">全景洞察</Text>
          <h1>日志统计与分析</h1>
          <p>支持按时间段、API Key、账号池与渠道多维度交叉透视，深度排查请求轨迹与性能瓶颈。</p>
        </div>
        <div className="title-actions">
          <Button appearance="secondary" icon={<ArrowClockwise24Regular />} onClick={() => { void loadAnalytics(); void loadLogs(1); }} disabled={loading}>
            刷新数据
          </Button>
        </div>
      </div>

      {/* 1. 多维度筛选面板 */}
      <Card className="analytics-filter-card">
        <div className="time-range-bar">
          <span className="filter-label">时间范围：</span>
          <div className="time-range-pills">
            {[
              { id: '1h', label: '近1小时' },
              { id: 'today', label: '今日' },
              { id: '24h', label: '近24小时' },
              { id: '7d', label: '近7天' },
              { id: '30d', label: '近30天' },
              { id: 'all', label: '全部历史' },
              { id: 'custom', label: '自定义时间' },
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                className={`time-pill ${timeRange === item.id ? 'active' : ''}`}
                onClick={() => {
                  setTimeRange(item.id);
                  setPage(1);
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {timeRange === 'custom' && (
          <div className="custom-time-row">
            <Field label="开始时间">
              <Input type="datetime-local" value={customStart} onChange={(_, d) => setCustomStart(d.value)} />
            </Field>
            <span className="custom-time-separator">至</span>
            <Field label="结束时间">
              <Input type="datetime-local" value={customEnd} onChange={(_, d) => setCustomEnd(d.value)} />
            </Field>
            <Button appearance="primary" onClick={() => { void loadAnalytics(); void loadLogs(1); }}>
              应用自定义区间
            </Button>
          </div>
        )}

        <div className="analytics-dimension-grid">
          <Field label="渠道筛选">
            <Select value={provider} onChange={(_, d) => { setProvider(d.value); setPage(1); }}>
              <option value="all">全部渠道 (All Providers)</option>
              {data?.filterOptions?.providers?.map((p) => (
                <option key={p} value={p}>{labelFor(providerLabels, p)}</option>
              ))}
            </Select>
          </Field>

          <Field label="API Key 筛选">
            <Select value={apiKeyId} onChange={(_, d) => { setApiKeyId(d.value); setPage(1); }}>
              <option value="all">全部来源 (All API Keys)</option>
              <option value="test">🛠️ 控制台测试 (Console Test)</option>
              {data?.filterOptions?.apiKeys?.map((k) => (
                <option key={k.id} value={k.id}>🔑 {k.name} ({k.key_prefix}...)</option>
              ))}
            </Select>
          </Field>

          <Field label="账号池账号">
            <Select value={accountId} onChange={(_, d) => { setAccountId(d.value); setPage(1); }}>
              <option value="all">全部账号 (All Accounts)</option>
              {data?.filterOptions?.accounts?.map((a) => (
                <option key={a.id} value={a.id}>[{labelFor(providerLabels, a.provider)}] {a.name}</option>
              ))}
            </Select>
          </Field>

          <Field label="模型筛选">
            <Select value={model} onChange={(_, d) => { setModel(d.value); setPage(1); }}>
              <option value="all">全部模型 (All Models)</option>
              {data?.filterOptions?.models?.map((m) => (
                <option key={m.id} value={m.id}>{m.id} ({labelFor(providerLabels, m.provider)})</option>
              ))}
            </Select>
          </Field>

          <Field label="状态筛选">
            <Select value={status} onChange={(_, d) => { setStatus(d.value); setPage(1); }}>
              <option value="all">全部状态 (All Status)</option>
              <option value="completed">✅ 成功 (Completed)</option>
              <option value="failed">❌ 失败 (Failed)</option>
            </Select>
          </Field>

          <Field label="关键词搜索">
            <div className="search-input-group">
              <Input
                placeholder="搜索请求 ID / 模型名…"
                value={keyword}
                onChange={(_, d) => setKeyword(d.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { void loadAnalytics(); void loadLogs(1); } }}
              />
              <Button appearance="subtle" onClick={resetFilters}>重置</Button>
            </div>
          </Field>
        </div>
      </Card>

      {/* 2. 核心指标概览卡片矩阵 */}
      <div className="analytics-summary-grid">
        <div className="analytics-stat-card">
          <span className="stat-label">总调用量</span>
          <strong className="stat-number">{summary?.requests ?? 0}</strong>
          <div className="stat-sub">
            <span>成功: {summary?.completed ?? 0}</span>
            <span className="failed-text">失败: {summary?.failed ?? 0}</span>
          </div>
        </div>

        <div className="analytics-stat-card">
          <span className="stat-label">整体成功率</span>
          <strong className={`stat-number ${(summary?.success_rate ?? 100) >= 90 ? 'stat-success' : (summary?.success_rate ?? 100) >= 70 ? 'stat-warning' : 'stat-danger'}`}>
            {summary?.success_rate !== undefined ? `${summary.success_rate}%` : '—'}
          </strong>
          <div className="stat-sub">
            <span className="stat-progress-bar">
              <span className="stat-progress-fill" style={{ width: `${summary?.success_rate ?? 0}%` }} />
            </span>
          </div>
        </div>

        <div className="analytics-stat-card">
          <span className="stat-label">平均响应耗时</span>
          <strong className="stat-number">{formatMs(summary?.avg_latency)}</strong>
          <div className="stat-sub">
            <span>P95 尾部延迟: {formatMs(summary?.p95_latency)}</span>
          </div>
        </div>

        <div className="analytics-stat-card">
          <span className="stat-label">生图资产生成</span>
          <strong className="stat-number stat-highlight">{summary?.image_count ?? 0} 张</strong>
          <div className="stat-sub">
            <span>支持 CogView/万相/即梦等</span>
          </div>
        </div>

        <div className="analytics-stat-card">
          <span className="stat-label">活跃 API 密钥</span>
          <strong className="stat-number">{summary?.active_keys ?? 0}</strong>
          <div className="stat-sub">
            <span>产生调用的业务密钥</span>
          </div>
        </div>

        <div className="analytics-stat-card">
          <span className="stat-label">承载账号数</span>
          <strong className="stat-number">{summary?.active_accounts ?? 0}</strong>
          <div className="stat-sub">
            <span>参与请求分配的账号</span>
          </div>
        </div>
      </div>

      {/* 3. 流量趋势直方图 */}
      <Card className="analytics-chart-card">
        <div className="chart-header">
          <div>
            <h3>请求流量与成功率时序分布</h3>
            <small>绿色表示成功完成的调用，红色表示失败调用，柱高代表该时段总并发量。</small>
          </div>
        </div>
        {timeSeries.length ? (
          <div className="trend-histogram">
            {timeSeries.map((pt, idx) => {
              const successHeight = (pt.completed / maxReqInSeries) * 100;
              const failHeight = (pt.failed / maxReqInSeries) * 100;
              return (
                <div className="histogram-col" key={idx} title={`时间: ${pt.time}\n总请求: ${pt.requests}\n成功: ${pt.completed}\n失败: ${pt.failed}\n成功率: ${pt.success_rate}%\n平均耗时: ${formatMs(pt.avg_latency)}`}>
                  <div className="histogram-bar-track">
                    {pt.failed > 0 && <div className="bar-segment fail" style={{ height: `${failHeight}%` }} />}
                    {pt.completed > 0 && <div className="bar-segment success" style={{ height: `${successHeight}%` }} />}
                  </div>
                  <span className="histogram-label">{pt.time}</span>
                  <span className="histogram-count">{pt.requests}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="empty-state">所选时间范围内暂无调用流量。</div>
        )}
      </Card>

      {/* 4. 多维度透视与明细查询 */}
      <div className="analytics-tabs-wrapper">
        <div className="analytics-nav-tabs">
          <button type="button" className={`tab-btn ${activeTab === 'provider' ? 'active' : ''}`} onClick={() => setActiveTab('provider')}>
            🏷️ 渠道表现 ({data?.byProvider?.length ?? 0})
          </button>
          <button type="button" className={`tab-btn ${activeTab === 'apiKey' ? 'active' : ''}`} onClick={() => setActiveTab('apiKey')}>
            🔑 API Key 调用排行 ({data?.byApiKey?.length ?? 0})
          </button>
          <button type="button" className={`tab-btn ${activeTab === 'account' ? 'active' : ''}`} onClick={() => setActiveTab('account')}>
            👥 账号池负载分析 ({data?.byAccount?.length ?? 0})
          </button>
          <button type="button" className={`tab-btn ${activeTab === 'model' ? 'active' : ''}`} onClick={() => setActiveTab('model')}>
            🤖 模型使用分布 ({data?.byModel?.length ?? 0})
          </button>
          <button type="button" className={`tab-btn ${activeTab === 'logs' ? 'active' : ''}`} onClick={() => setActiveTab('logs')}>
            📋 明细日志查询 ({totalLogs})
          </button>
        </div>

        {/* Tab 1: 按渠道 */}
        {activeTab === 'provider' && (
          <Card className="table-card analytics-sub-card">
            <div className="data-table">
              <div className="data-head provider-head">
                <span>渠道名称</span>
                <span>总请求数</span>
                <span>成功完成</span>
                <span>失败数</span>
                <span>成功率</span>
                <span>平均响应耗时</span>
                <span>操作</span>
              </div>
              {data?.byProvider?.length ? (
                data.byProvider.map((p) => (
                  <div className="data-row provider-row" key={p.provider}>
                    <span className="row-title"><strong>{labelFor(providerLabels, p.provider)}</strong> <small>({p.provider})</small></span>
                    <span>{p.requests}</span>
                    <span className="success-text">{p.completed}</span>
                    <span className={p.failed > 0 ? 'failed-text' : ''}>{p.failed}</span>
                    <span>
                      <Badge appearance="tint" color={p.success_rate >= 90 ? 'success' : p.success_rate >= 70 ? 'warning' : 'danger'}>
                        {p.success_rate}%
                      </Badge>
                    </span>
                    <span>{formatMs(p.avg_latency)}</span>
                    <span>
                      <Button appearance="subtle" size="small" onClick={() => { setProvider(p.provider); setActiveTab('logs'); setPage(1); }}>
                        查看明细
                      </Button>
                    </span>
                  </div>
                ))
              ) : (
                <div className="empty-state">暂无渠道统计数据。</div>
              )}
            </div>
          </Card>
        )}

        {/* Tab 2: 按 API Key */}
        {activeTab === 'apiKey' && (
          <Card className="table-card analytics-sub-card">
            <div className="data-table">
              <div className="data-head key-head">
                <span>API Key 名称 / 前缀</span>
                <span>角色类型</span>
                <span>请求量</span>
                <span>成功完成</span>
                <span>失败数</span>
                <span>成功率</span>
                <span>平均耗时</span>
                <span>最后活跃时间</span>
                <span>操作</span>
              </div>
              {data?.byApiKey?.length ? (
                data.byApiKey.map((k, i) => (
                  <div className="data-row key-row" key={k.api_key_id ?? `none-${i}`}>
                    <span className="row-title">
                      <strong>{k.key_name}</strong>
                      {k.key_prefix && k.key_prefix !== '—' ? <small><code>{k.key_prefix}...</code></small> : null}
                    </span>
                    <span><Badge appearance="tint">{labelFor(roleLabels, k.role)}</Badge></span>
                    <span>{k.requests}</span>
                    <span className="success-text">{k.completed}</span>
                    <span className={k.failed > 0 ? 'failed-text' : ''}>{k.failed}</span>
                    <span>
                      <Badge appearance="tint" color={k.success_rate >= 90 ? 'success' : k.success_rate >= 70 ? 'warning' : 'danger'}>
                        {k.success_rate}%
                      </Badge>
                    </span>
                    <span>{formatMs(k.avg_latency)}</span>
                    <span>{k.last_used_at ? new Date(k.last_used_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</span>
                    <span>
                      <Button appearance="subtle" size="small" onClick={() => { setApiKeyId(k.api_key_id || 'test'); setActiveTab('logs'); setPage(1); }}>
                        查看明细
                      </Button>
                    </span>
                  </div>
                ))
              ) : (
                <div className="empty-state">暂无 API Key 统计数据。</div>
              )}
            </div>
          </Card>
        )}

        {/* Tab 3: 按账号池 */}
        {activeTab === 'account' && (
          <Card className="table-card analytics-sub-card">
            <div className="data-table">
              <div className="data-head account-head">
                <span>账号名称</span>
                <span>所属渠道</span>
                <span>优先级</span>
                <span>健康状态</span>
                <span>承载请求数</span>
                <span>成功完成</span>
                <span>失败数</span>
                <span>成功率</span>
                <span>平均耗时</span>
                <span>操作</span>
              </div>
              {data?.byAccount?.length ? (
                data.byAccount.map((a, i) => (
                  <div className="data-row account-row" key={a.account_id ?? `none-${i}`}>
                    <span className="row-title"><strong>{a.account_name}</strong></span>
                    <span>{labelFor(providerLabels, a.provider)}</span>
                    <span>{a.priority}</span>
                    <span><Badge appearance="tint" color={a.status === 'ready' ? 'success' : 'informative'}>{labelFor(statusLabels, a.status)}</Badge></span>
                    <span>{a.requests}</span>
                    <span className="success-text">{a.completed}</span>
                    <span className={a.failed > 0 ? 'failed-text' : ''}>{a.failed}</span>
                    <span>
                      <Badge appearance="tint" color={a.success_rate >= 90 ? 'success' : a.success_rate >= 70 ? 'warning' : 'danger'}>
                        {a.success_rate}%
                      </Badge>
                    </span>
                    <span>{formatMs(a.avg_latency)}</span>
                    <span>
                      {a.account_id ? (
                        <Button appearance="subtle" size="small" onClick={() => { setAccountId(a.account_id!); setActiveTab('logs'); setPage(1); }}>
                          查看明细
                        </Button>
                      ) : '—'}
                    </span>
                  </div>
                ))
              ) : (
                <div className="empty-state">暂无账号池统计数据。</div>
              )}
            </div>
          </Card>
        )}

        {/* Tab 4: 按模型 */}
        {activeTab === 'model' && (
          <Card className="table-card analytics-sub-card">
            <div className="data-table">
              <div className="data-head model-head">
                <span>模型名称</span>
                <span>所属渠道</span>
                <span>请求量</span>
                <span>成功完成</span>
                <span>失败数</span>
                <span>成功率</span>
                <span>平均响应耗时</span>
                <span>操作</span>
              </div>
              {data?.byModel?.length ? (
                data.byModel.map((m) => (
                  <div className="data-row model-row" key={m.model}>
                    <span className="row-title"><strong>{m.model}</strong></span>
                    <span>{labelFor(providerLabels, m.provider)}</span>
                    <span>{m.requests}</span>
                    <span className="success-text">{m.completed}</span>
                    <span className={m.failed > 0 ? 'failed-text' : ''}>{m.failed}</span>
                    <span>
                      <Badge appearance="tint" color={m.success_rate >= 90 ? 'success' : m.success_rate >= 70 ? 'warning' : 'danger'}>
                        {m.success_rate}%
                      </Badge>
                    </span>
                    <span>{formatMs(m.avg_latency)}</span>
                    <span>
                      <Button appearance="subtle" size="small" onClick={() => { setModel(m.model); setActiveTab('logs'); setPage(1); }}>
                        查看明细
                      </Button>
                    </span>
                  </div>
                ))
              ) : (
                <div className="empty-state">暂无模型统计数据。</div>
              )}
            </div>
          </Card>
        )}

        {/* Tab 5: 明细日志列表 */}
        {activeTab === 'logs' && (
          <Card className="table-card analytics-sub-card">
            <div className="logs-table-toolbar">
              <div>
                <strong>明细日志查询</strong>
                <small>共找到 {totalLogs} 条符合当前筛选条件的请求日志，点击任意行可查看单条全景详情。</small>
              </div>
              <div className="pagination-bar">
                <Button appearance="subtle" disabled={page <= 1 || loadingLogs} onClick={() => loadLogs(page - 1)}>上一页</Button>
                <span>第 {page} 页 / 共 {Math.max(1, Math.ceil(totalLogs / 20))} 页</span>
                <Button appearance="subtle" disabled={page * 20 >= totalLogs || loadingLogs} onClick={() => loadLogs(page + 1)}>下一页</Button>
              </div>
            </div>

            <div className="data-table logs-search-table">
              <div className="data-head log-search-head">
                <span>请求时间</span>
                <span>请求 ID</span>
                <span>渠道 / 模型</span>
                <span>内容预览</span>
                <span>执行账号</span>
                <span>调用来源</span>
                <span>耗时</span>
                <span>状态</span>
                <span>操作</span>
              </div>
              {logs.length ? (
                logs.map((log) => (
                  <div className="data-row log-search-row" key={log.id} onClick={() => void openLogDetail(log.id)}>
                    <span><small>{new Date(log.started_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</small></span>
                    <span><code>{log.id.slice(0, 14)}</code></span>
                    <span>
                      <div className="model-cell">
                        <strong>{log.model ?? '—'}</strong>
                        <small>{labelFor(providerLabels, log.provider ?? '')}</small>
                      </div>
                    </span>
                    <span className="content-preview-cell">
                      {log.prompt_preview ? <p className="preview-prompt">Q: {log.prompt_preview}</p> : null}
                      {log.reply_preview ? <p className="preview-reply">A: {log.reply_preview}</p> : null}
                      {log.has_images ? <span className="preview-tag">🖼️ 生成画作</span> : null}
                    </span>
                    <span>{log.account_name ?? '—'}</span>
                    <span>{log.api_key_name ? `${log.api_key_name} (${log.key_prefix}...)` : log.kind === 'connection_test' ? '🛠️ 控制台' : '系统 API'}</span>
                    <span>{formatMs(log.latency_ms)}</span>
                    <span>
                      <Badge appearance="tint" color={log.status === 'completed' ? 'success' : log.status === 'failed' ? 'danger' : 'informative'}>
                        {labelFor(statusLabels, log.status)}
                      </Badge>
                    </span>
                    <span>
                      <Button appearance="primary" size="small" onClick={(e) => { e.stopPropagation(); void openLogDetail(log.id); }}>
                        详情
                      </Button>
                    </span>
                  </div>
                ))
              ) : (
                <div className="empty-state">未找到匹配的请求日志。</div>
              )}
            </div>
          </Card>
        )}
      </div>

      {/* 5. 单条日志全景深度检查器弹窗 */}
      {inspectLogId && (
        <Dialog open={!!inspectLogId} onOpenChange={(_, d) => { if (!d.open) { setInspectLogId(null); setInspectDetail(null); } }}>
          <DialogSurface className="log-inspector-dialog">
            <DialogBody>
              <DialogTitle className="inspector-title">
                <span>单条请求全景审计 · <code>{inspectLogId}</code></span>
              </DialogTitle>
              <DialogContent className="inspector-content">
                {inspectLoading || !inspectDetail ? (
                  <div className="inspector-loading"><Spinner label="正在读取该请求完整轨迹与上下文…" /></div>
                ) : (
                  <div className="inspector-layout">
                    {/* 元数据卡片 */}
                    <div className="inspector-meta-grid">
                      <div className="meta-card">
                        <span className="meta-label">渠道 / 模型</span>
                        <strong>{inspectDetail.log.model}</strong>
                        <small>{labelFor(providerLabels, inspectDetail.log.provider)} · {inspectDetail.log.kind}</small>
                      </div>
                      <div className="meta-card">
                        <span className="meta-label">响应状态</span>
                        <strong>
                          <Badge appearance="tint" color={inspectDetail.log.status === 'completed' ? 'success' : 'danger'}>
                            {inspectDetail.log.status} (HTTP {inspectDetail.log.http_status ?? 200})
                          </Badge>
                        </strong>
                        <small>总耗时: {formatMs(inspectDetail.log.latency_ms)}</small>
                      </div>
                      <div className="meta-card">
                        <span className="meta-label">执行账号</span>
                        <strong>{inspectDetail.log.account_name ?? '—'}</strong>
                        <small>优先级: {inspectDetail.log.account_priority ?? '—'}</small>
                      </div>
                      <div className="meta-card">
                        <span className="meta-label">调用来源 / Key</span>
                        <strong>{inspectDetail.log.api_key_name ? `${inspectDetail.log.api_key_name} (${inspectDetail.log.key_prefix}...)` : '🛠️ 控制台测试'}</strong>
                        <small>角色: {inspectDetail.log.api_key_role ?? 'system'}</small>
                      </div>
                    </div>

                    {/* 失败报错横幅 */}
                    {inspectDetail.failureError && (
                      <div className="inspector-error-banner">
                        <strong>⚠️ 请求失败原因</strong>
                        <p>{inspectDetail.failureError}</p>
                      </div>
                    )}

                    {/* 用户提问上下文 */}
                    {inspectDetail.promptMessages?.length > 0 && (
                      <div className="inspector-section">
                        <h4>📨 上游对话上下文 (Prompt Messages)</h4>
                        <div className="inspector-prompt-list">
                          {inspectDetail.promptMessages.map((msg, i) => (
                            <div key={i} className={`prompt-msg-item ${msg.role || 'user'}`}>
                              <span className="msg-role-tag">{msg.role}</span>
                              <div className="msg-body">
                                <MarkdownText value={typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2)} />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* 思考链折叠 */}
                    {inspectDetail.reasoning && (
                      <div className="inspector-section">
                        <h4>💭 深度思考过程 (Thinking Chain)</h4>
                        <div className="inspector-reasoning-box">
                          <MarkdownText value={inspectDetail.reasoning} />
                        </div>
                      </div>
                    )}

                    {/* 助手回复内容 */}
                    {inspectDetail.assistantReply && (
                      <div className="inspector-section">
                        <h4>🤖 助手最终响应 (Assistant Reply)</h4>
                        <div className="inspector-reply-box">
                          <MarkdownText value={inspectDetail.assistantReply} />
                        </div>
                      </div>
                    )}

                    {/* 生成画作 */}
                    {inspectDetail.images?.length > 0 && (
                      <div className="inspector-section">
                        <h4>🖼️ 本次生成画作资产</h4>
                        <div className="inspector-image-gallery">
                          {inspectDetail.images.map((imgUrl, i) => (
                            <a key={i} href={resolveImgUrl(imgUrl)} target="_blank" rel="noreferrer" className="inspector-image-thumb">
                              <img src={resolveImgUrl(imgUrl)} alt="Generated asset" />
                            </a>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* 完整事件轨迹 */}
                    <div className="inspector-section">
                      <h4>📜 完整事件轨迹 (Audit Events Timeline - {inspectDetail.events.length} 个事件)</h4>
                      <EventTimeline events={inspectDetail.events} />
                    </div>
                  </div>
                )}
              </DialogContent>
              <DialogActions>
                <Button appearance="primary" onClick={() => { setInspectLogId(null); setInspectDetail(null); }}>
                  关闭
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    </section>
  );
}


type AuditEvent = { id?: number; request_id?: string; requestId?: string; at: number; level: 'debug' | 'info' | 'warn' | 'error'; event: string; message: string; details_json?: string; details?: Record<string, unknown> };

function EventTimeline({ events }: { events: AuditEvent[] }) {
  if (!events.length) return <div className="empty-state">还没有可展示的事件。开始一次连接测试或 API 调用后，路由与上游事件会在此处出现。</div>;
  const eventLabels: Record<string, string> = { 'request.routed': '路由决策', 'request.sent': '发送消息', 'upstream.message': '收到助手回复', 'upstream.reasoning': '收到思考链', 'upstream.citation': '收到搜索引用', 'upstream.image': '收到生成图片', 'request.completed': '请求完成', 'request.failed': '请求失败', 'gateway.error': '网关错误', 'transport.error': '传输错误' };
  const eventMessages: Record<string, string> = { 'request.routed': '已选择可用账号并建立上游链路。', 'request.sent': '系统已向上游发送当前对话。', 'upstream.message': '已收到助手回复内容。', 'upstream.reasoning': '已收到模型思考摘要。', 'upstream.citation': '已收到搜索结果引用。', 'upstream.image': '已收到生成内容。', 'request.completed': '本次请求已完成。' };
  return <div className="audit-timeline">{[...events].sort((a, b) => b.at - a.at).map((item, index) => {
    let details = item.details;
    if (!details && item.details_json) { try { details = JSON.parse(item.details_json) as Record<string, unknown>; } catch { details = undefined; } }
    const content = typeof details?.content === 'string' ? details.content : '';
    const sentMessages = Array.isArray(details?.messages) ? details.messages.filter((message): message is { role?: string; content?: unknown } => Boolean(message && typeof message === 'object' && 'content' in message)) : [];
    const metadata = details ? Object.fromEntries(Object.entries(details).filter(([key]) => key !== 'content' && key !== 'messages')) : {};
    return <div className={`audit-event ${item.level}`} key={`${item.id ?? item.at}-${index}`}><span className="audit-dot" /><div><div className="audit-event-head"><code>{eventLabels[item.event] ?? item.event}</code><small>{new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(item.at)}</small></div><p>{eventMessages[item.event] ?? item.message}</p>{sentMessages.length ? <div className="audit-message-block"><span className="audit-message-label">发送内容</span>{sentMessages.map((message, messageIndex) => <div className="audit-message-content" key={messageIndex}><small>{message.role ?? 'message'}</small><MarkdownText value={typeof message.content === 'string' ? message.content : JSON.stringify(message.content)} /></div>)}</div> : null}{content ? <div className="audit-message-block"><span className="audit-message-label">接收内容</span><div className="audit-message-content"><MarkdownText value={content} /></div></div> : null}{Object.keys(metadata).length ? <pre>{JSON.stringify(metadata, null, 2)}</pre> : null}</div></div>;
  })}</div>;
}

function LiveLogsPage({ logs, refresh }: { logs: Log[]; refresh: () => void }) {
  const [selected, setSelected] = useState<Log | null>(null); const [events, setEvents] = useState<AuditEvent[]>([]); const [live, setLive] = useState<AuditEvent[]>([]);
  useEffect(() => { const source = new EventSource(`${API_BASE}/api/logs/live`); source.onmessage = (message) => { try { const next = JSON.parse(message.data) as AuditEvent; setLive((items) => [...items, next].slice(-40)); } catch { /* ignore malformed transport data */ } }; return () => source.close(); }, []);
  useEffect(() => { if (!selected) { setEvents([]); return; } void api<AuditEvent[]>(`/api/logs/${selected.id}/events`).then(setEvents); }, [selected]);
  const displayedEvents = selected ? events : live;
  return <section className="module-page logs-page"><div className="section-title"><div><Text className="eyebrow">可审计事件</Text><h1>实时日志</h1><p>实时流、历史记录和连接测试使用同一条已脱敏的事件轨迹。</p></div></div><Card className="logs-workbench"><div className="logs-content-grid"><section className="logs-request-column"><div className="logs-toolbar"><div><strong>请求队列</strong><small>选择请求后，在右侧查看完整事件轨迹。</small></div><Button icon={<ArrowClockwise24Regular />} onClick={refresh}>刷新</Button></div><Card className="table-card logs-request-card">{logs.length ? <div className="request-activity-list">{logs.map((log) => <RequestActivityCard key={log.id} log={log} selected={selected?.id === log.id} onSelect={() => setSelected(log)} />)}</div> : <div className="empty-state">暂无历史请求。</div>}</Card></section><Card className="event-card audit-card test-log-card logs-event-card"><div className="event-header test-log-header"><div><strong>{selected ? '请求轨迹' : '实时事件'}</strong><small>{selected ? `请求 ${selected.id.slice(0, 14)} 的完整记录` : '新发生的事件显示在最上方'}</small></div><Badge appearance="tint" color={displayedEvents.some((item) => item.level === 'error') ? 'danger' : 'informative'}>{selected ? '已选请求' : '实时流'}</Badge></div><EventTimeline events={displayedEvents} /></Card></div></Card></section>;
}

type ImageLogItem = {
  id: string;
  url: string;
  prompt: string;
  model: string;
  provider: string;
  kind: string;
  status: string;
  latency_ms: number | null;
  created_at: number;
  request_id: string;
  account_name: string | null;
  api_key_name: string | null;
  key_prefix: string | null;
};

function ImageLogsPage() {
  const [items, setItems] = useState<ImageLogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<ImageLogItem | null>(null);
  const [search, setSearch] = useState('');
  const [filterProvider, setFilterProvider] = useState('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<ImageLogItem[]>('/api/image-logs');
      setItems(data);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    return items.filter((item) => {
      if (filterProvider !== 'all' && item.provider !== filterProvider) return false;
      if (search) {
        const q = search.toLowerCase();
        const matchPrompt = item.prompt.toLowerCase().includes(q);
        const matchKey = (item.api_key_name || '').toLowerCase().includes(q) || (item.key_prefix || '').toLowerCase().includes(q);
        const matchModel = (item.model || '').toLowerCase().includes(q);
        const matchAccount = (item.account_name || '').toLowerCase().includes(q);
        if (!matchPrompt && !matchKey && !matchModel && !matchAccount) return false;
      }
      return true;
    });
  }, [items, filterProvider, search]);

  const resolveImgUrl = (url: string) => {
    if (!url) return '';
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) return url;
    return `${API_BASE}${url.startsWith('/') ? '' : '/'}${url}`;
  };

  return (
    <section className="module-page image-logs-page">
      <div className="section-title">
        <div>
          <Text className="eyebrow">生成资产</Text>
          <h1>图片日志</h1>
          <p>汇总所有生图模型（ChatGPT / GLM / Qwen / 即梦等）生成的画作资产、生图提示词与调用的 API Key。</p>
        </div>
        <div className="page-actions">
          <Button icon={<ArrowClockwise24Regular />} onClick={() => void load()} disabled={loading}>
            {loading ? '刷新中...' : '刷新'}
          </Button>
        </div>
      </div>

      <div className="image-logs-toolbar">
        <div className="image-logs-search">
          <Input
            value={search}
            onChange={(_, data) => setSearch(data.value)}
            placeholder="搜索提示词、API Key 名称、前缀或模型..."
            style={{ width: 320 }}
          />
        </div>
        <div className="image-logs-filter">
          <Select value={filterProvider} onChange={(_, data) => setFilterProvider(data.value)}>
            <option value="all">全部渠道 ({items.length})</option>
            <option value="chatgpt">ChatGPT DALL-E</option>
            <option value="glm">智谱 GLM CogView</option>
            <option value="qwen">通义万相 Qwen</option>
            <option value="jimeng">即梦 AI</option>
          </Select>
        </div>
      </div>

      {loading && !items.length ? (
        <div className="image-logs-loading">
          <Spinner label="正在加载生图日志..." />
        </div>
      ) : filtered.length ? (
        <div className="image-gallery-grid">
          {filtered.map((item) => (
            <Card className="image-log-card" key={item.id}>
              <div className="image-thumbnail-wrap" onClick={() => setPreview(item)}>
                <img
                  src={resolveImgUrl(item.url)}
                  alt={item.prompt || 'Generated Image'}
                  loading="lazy"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200"><rect width="300" height="200" fill="%23222"/><text x="50%" y="50%" fill="%23888" dominant-baseline="middle" text-anchor="middle">图片已归档或离线</text></svg>';
                  }}
                />
                <div className="image-hover-overlay">
                  <span>点击查看大图</span>
                </div>
              </div>

              <div className="image-card-body">
                <div className="image-card-header">
                  <Badge appearance="tint" color="informative">
                    {labelFor(providerLabels, item.provider)}
                  </Badge>
                  <span className="image-model-name">{item.model}</span>
                  <span className="image-card-time">
                    {new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(item.created_at)}
                  </span>
                </div>

                <div className="image-prompt-box" title={item.prompt || '无提示词记录'}>
                  <strong>提示词：</strong>
                  <span>{item.prompt || '（未记录具体提示词）'}</span>
                </div>

                <div className="image-meta-row">
                  <div className="image-meta-item">
                    <small>调用来源 / API Key</small>
                    {item.api_key_name ? (
                      <span className="api-key-badge" title={`Key 前缀: ${item.key_prefix || '—'}`}>
                        🔑 {item.api_key_name} {item.key_prefix ? `(${item.key_prefix}...)` : ''}
                      </span>
                    ) : item.kind === 'connection_test' ? (
                      <span className="internal-badge">🛠️ 控制台测试</span>
                    ) : (
                      <span className="anon-badge">🌐 系统 API</span>
                    )}
                  </div>

                  {item.account_name ? (
                    <div className="image-meta-item">
                      <small>执行账号</small>
                      <span>{item.account_name}</span>
                    </div>
                  ) : null}
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card className="table-card empty-gallery-card">
          <div className="empty-state">
            暂无匹配的生图记录。在「连接测试」或通过 API 调用生图模型（如 Qwen-Image、GLM-Image、jimeng-3.1 等）后，生成的画作将实时汇聚于此。
          </div>
        </Card>
      )}

      {preview ? (
        <Dialog open={!!preview} onOpenChange={(_, data) => { if (!data.open) setPreview(null); }}>
          <DialogSurface className="image-preview-dialog">
            <DialogBody>
              <DialogTitle>生图详情与原图预览</DialogTitle>
              <DialogContent>
                <div className="image-preview-content">
                  <div className="image-preview-box">
                    <img src={resolveImgUrl(preview.url)} alt={preview.prompt} />
                  </div>
                  <div className="image-preview-details">
                    <div className="preview-detail-item">
                      <strong>提示词 (Prompt)</strong>
                      <p className="preview-prompt-text">{preview.prompt || '无'}</p>
                    </div>
                    <div className="preview-grid-2">
                      <div className="preview-detail-item">
                        <strong>模型 (Model)</strong>
                        <p>{preview.model} ({labelFor(providerLabels, preview.provider)})</p>
                      </div>
                      <div className="preview-detail-item">
                        <strong>调用来源 / API Key</strong>
                        <p>
                          {preview.api_key_name
                            ? `🔑 ${preview.api_key_name} (${preview.key_prefix || ''}...)`
                            : preview.kind === 'connection_test' ? '🛠️ 控制台测试' : '🌐 系统 API'}
                        </p>
                      </div>
                      <div className="preview-detail-item">
                        <strong>执行账号</strong>
                        <p>{preview.account_name || '—'}</p>
                      </div>
                      <div className="preview-detail-item">
                        <strong>生成耗时</strong>
                        <p>{preview.latency_ms ? `${(preview.latency_ms / 1000).toFixed(1)} 秒 (${preview.latency_ms} ms)` : '—'}</p>
                      </div>
                      <div className="preview-detail-item">
                        <strong>生成时间</strong>
                        <p>{new Date(preview.created_at).toLocaleString('zh-CN')}</p>
                      </div>
                      <div className="preview-detail-item">
                        <strong>请求 ID</strong>
                        <p><code>{preview.request_id}</code></p>
                      </div>
                    </div>
                  </div>
                </div>
              </DialogContent>
              <DialogActions>
                <a
                  className="download-image-btn"
                  href={resolveImgUrl(preview.url)}
                  download={`image_${preview.id}.png`}
                  target="_blank"
                  rel="noreferrer"
                >
                  在新标签页打开原图
                </a>
                <Button appearance="secondary" onClick={() => setPreview(null)}>
                  关闭
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      ) : null}
    </section>
  );
}

function MarkdownText({ value }: { value: string }) {
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
  const tableDivider = (line: string) => { const values = cells(line); return values.length > 0 && values.every((cell) => /^:?-{3,}:?$/.test(cell)); };
  const tableAlign = (cell: string): 'left' | 'center' | 'right' => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left';
  const inline = (text: string): ReactNode[] => {
    const tokens = /(!\[[^\]]*\]\((?:https?:\/\/[^\s)]+|\/[^\s)]+)\)|\[[^\]]+\]\((?:https?:\/\/[^\s)]+|\/[^\s)]+)\)|`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_)/g;
    const result: ReactNode[] = [];
    let cursor = 0; let match: RegExpExecArray | null; let index = 0;
    while ((match = tokens.exec(text))) {
      if (match.index > cursor) result.push(text.slice(cursor, match.index));
      const token = match[0];
      const image = token.match(/^!\[([^\]]*)\]\((https?:\/\/[^\s)]+|\/[^\s)]+)\)$/);
      const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]+)\)$/);
      if (image) {
        const src = image[2].startsWith('http') ? image[2] : `${API_BASE}${image[2]}`;
        result.push(<img key={`image-${index}`} src={src} alt={image[1]} loading="lazy" />);
      } else if (link) {
        const href = link[2].startsWith('http') ? link[2] : `${API_BASE}${link[2]}`;
        result.push(<a key={`link-${index}`} href={href} target="_blank" rel="noreferrer">{link[1]}</a>);
      } else if (token.startsWith('`')) result.push(<code key={`code-${index}`}>{token.slice(1, -1)}</code>);
      else if (token.startsWith('**')) result.push(<strong key={`strong-${index}`}>{token.slice(2, -2)}</strong>);
      else if (token.startsWith('~~')) result.push(<del key={`del-${index}`}>{token.slice(2, -2)}</del>);
      else result.push(<em key={`em-${index}`}>{token.slice(1, -1)}</em>);
      cursor = match.index + token.length; index += 1;
    }
    if (cursor < text.length) result.push(text.slice(cursor));
    return result;
  };

  const lines = value.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = line.match(/^\s*```\s*([\w-]*)\s*$/);
    if (fence) {
      const language = fence[1]; const code: string[] = []; index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) { code.push(lines[index]); index += 1; }
      if (index < lines.length) index += 1;
      blocks.push(<pre className="markdown-code" key={`block-${blocks.length}`}><code data-language={language || undefined}>{code.join('\n')}</code></pre>);
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) { const level = Math.min(6, heading[1].length); const Heading = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'; blocks.push(<Heading className="markdown-heading" key={`block-${blocks.length}`}>{inline(heading[2])}</Heading>); index += 1; continue; }
    if (line.includes('|') && index + 1 < lines.length && tableDivider(lines[index + 1])) {
      const headers = cells(line); const alignments = cells(lines[index + 1]).map(tableAlign); const rows: string[][] = []; index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) { rows.push(cells(lines[index])); index += 1; }
      blocks.push(<div className="markdown-table-wrap" key={`block-${blocks.length}`}><table className="markdown-table"><thead><tr>{headers.map((header, column) => <th key={column} style={{ textAlign: alignments[column] ?? 'left' }}>{inline(header)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, column) => <td key={column} style={{ textAlign: alignments[column] ?? 'left' }}>{inline(row[column] ?? '')}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (unordered) {
      const items: string[] = [];
      while (index < lines.length) { const item = lines[index].match(/^\s*[-*+]\s+(.+)$/); if (!item) break; items.push(item[1]); index += 1; }
      blocks.push(<ul className="markdown-list" key={`block-${blocks.length}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>)}</ul>); continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      const items: string[] = [];
      while (index < lines.length) { const item = lines[index].match(/^\s*\d+[.)]\s+(.+)$/); if (!item) break; items.push(item[1]); index += 1; }
      blocks.push(<ol className="markdown-list" key={`block-${blocks.length}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>)}</ol>); continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) { quote.push(lines[index].replace(/^\s*>\s?/, '')); index += 1; }
      blocks.push(<blockquote className="markdown-quote" key={`block-${blocks.length}`}>{inline(quote.join('\n'))}</blockquote>); continue;
    }
    const paragraph: string[] = [line]; index += 1;
    while (index < lines.length && lines[index].trim() && !/^\s*(```|#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?)/.test(lines[index])) { paragraph.push(lines[index]); index += 1; }
    blocks.push(<p className="markdown-paragraph" key={`block-${blocks.length}`}>{inline(paragraph.join('\n'))}</p>);
  }
  return <div className="markdown-text">{blocks}</div>;
}

function TestConsole({ models, accounts }: { models: Array<{ id: string; provider: string }>; accounts: Account[] }) {
  type Message = { id: string; role: string; content: string; reasoning?: string; citations?: Array<{ title?: string; url?: string }> };
  const [model, setModel] = useState(models[0]?.id ?? '');
  const [accountId, setAccountId] = useState('');
  const [prompt, setPrompt] = useState('');
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const selectedAccount = accounts.find((account) => account.id === accountId);
  const modelChoices = selectedAccount ? models.filter((item) => item.provider === selectedAccount.provider) : models;
  const selectedModel = modelChoices.find((item) => item.id === model) ?? modelChoices[0];
  const accountChoices = selectedModel ? accounts.filter((account) => account.status === 'ready' && account.provider === selectedModel.provider) : accounts.filter((account) => account.status === 'ready');
  const activeModel = selectedModel?.id ?? '';

  useEffect(() => {
    const textarea = promptRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [prompt]);

  function chooseModel(next: string) {
    setModel(next);
    const nextProvider = models.find((item) => item.id === next)?.provider;
    if (accountId && accounts.find((account) => account.id === accountId)?.provider !== nextProvider) setAccountId('');
  }

  function chooseAccount(next: string) {
    setAccountId(next);
    const nextAccount = accounts.find((account) => account.id === next);
    if (nextAccount && models.find((item) => item.id === model)?.provider !== nextAccount.provider) {
      setModel(models.find((item) => item.provider === nextAccount.provider)?.id ?? '');
    }
  }

  async function send() {
    const text = prompt.trim();
    if (!activeModel || !text || busy) return;
    const sentAt = Date.now();
    const assistantMessageId = `assistant-${sentAt}`;
    setMessages((items) => [...items, { id: `user-${sentAt}`, role: 'user', content: text }]);
    setPrompt('');
    setEvents([{ at: sentAt, level: 'info', event: 'request.sent', message: '已发送消息到上游', details: { model: activeModel, content: text } }]);
    setBusy(true);
    let answer = '';
    let reasoning = '';
    let citations: Array<{ title?: string; url?: string }> = [];
    let requestId = '';
    let buffer = '';

    try {
      const token = localStorage.getItem('a2a_token');
      const response = await fetch(`${API_BASE}/api/connection-test`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ model: activeModel, accountId: accountId || undefined, messages: [...messages, { role: 'user', content: text }], stream: true })
      });
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error('无法创建流');

      const handleLine = (line: string) => {
        if (!line.startsWith('data: ') || line.includes('[DONE]')) return;
        const payload = JSON.parse(line.slice(6));
        requestId = payload.id ?? requestId;
        if (payload.error) {
          setEvents((items) => [...items, { at: Date.now(), level: 'error', event: 'gateway.error', message: payload.error.message }]);
          return;
        }
        const delta = payload.choices?.[0]?.delta ?? {};
        answer += delta.content ?? '';
        reasoning += delta.reasoning_content ?? '';
        citations = [...citations, ...(delta.annotations ?? []).filter((item: { type?: string }) => item.type === 'url_citation')];
        if (delta.content || delta.reasoning_content || delta.annotations) {
          const next = { id: assistantMessageId, role: 'assistant', content: answer, reasoning, citations };
          setMessages((items) => items.some((entry) => entry.id === assistantMessageId) ? items.map((entry) => entry.id === assistantMessageId ? next : entry) : [...items, next]);
        }
      };

      while (true) {
        const item = await reader.read();
        if (item.done) break;
        buffer += decoder.decode(item.value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        lines.forEach(handleLine);
      }
      if (buffer) handleLine(buffer);
      if (requestId) setEvents(await api<AuditEvent[]>('/api/logs/' + requestId + '/events'));
    } catch (reason) {
      setEvents((items) => [...items, { at: Date.now(), level: 'error', event: 'transport.error', message: reason instanceof Error ? reason.message : '请求失败' }]);
    } finally {
      setBusy(false);
    }
  }

  return <section className="test-page">
    <div className="section-title test-page-heading">
      <div><Text className="eyebrow">受控会话</Text><h1>连接测试</h1><p>用一条真实请求检查模型、账号租约与上游响应，所有事件在右侧集中呈现。</p></div>
    </div>
    <Card className="test-workbench">
      <div className="test-content-grid">
        <div className="test-chat-column">
          <div className="test-toolbar">
            <div className="test-select-group">
              <Field label="模型">
                <Select value={activeModel} onChange={(_, data) => chooseModel(data.value)} disabled={!models.length}>
                  {modelChoices.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}
                </Select>
              </Field>
              <span className="test-link-mark" aria-hidden="true">→</span>
              <Field label="账号">
                <Select value={accountId} onChange={(_, data) => chooseAccount(data.value)} disabled={!accountChoices.length}>
                  <option value="">{accountChoices.length ? '自动选择健康账号' : '暂无可用账号'}</option>
                  {accountChoices.map((account) => <option key={account.id} value={account.id}>{account.name} · 优先级 {account.priority}</option>)}
                </Select>
              </Field>
            </div>
          </div>
          <Card className="chat-card test-chat-card">
          <div className="composer">
            <textarea ref={promptRef} aria-label="测试消息" rows={1} value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void send(); }} placeholder="请输入要测试的内容…" />
            <Button appearance="primary" onClick={() => void send()} disabled={busy || !activeModel || !accountChoices.length}>{busy ? <Spinner size="tiny" /> : null}{busy ? '生成中' : '发送'}</Button>
          </div>
          <div className="chat-thread">
            {messages.length ? [...messages].reverse().map((message) => <div className={'chat-message ' + message.role} key={message.id}>
              {message.role === 'assistant' ? <div className="message-author"><span className="message-dot" />助手</div> : <div className="message-author user-author">你</div>}
              {message.reasoning ? <details className="reasoning" open><summary>💭 思考与搜索链</summary><MarkdownText value={message.reasoning} /></details> : null}
              <MarkdownText value={message.content} />
              {message.citations?.length ? <div className="citations"><span className="citation-label">搜索引用</span>{message.citations.map((item, citationIndex) => <a key={(item.url ?? '') + citationIndex} href={item.url} target="_blank" rel="noreferrer">{item.title || item.url}</a>)}</div> : null}
            </div>) : <div className="chat-empty test-chat-empty"><span className="empty-orbit"><Bot24Regular /></span><strong>开始一段对话</strong><span>先选模型和账号，再发送一条消息。思维链、搜索引用与响应内容会原样整理。</span></div>}
            {busy ? <div className="typing-indicator"><span /><span /><span />正在等待模型继续输出…</div> : null}
          </div>
          </Card>
        </div>
        <Card className="event-card audit-card test-log-card">
          <div className="event-header test-log-header"><div><strong>运行日志</strong><small>{events.length ? events.length + ' 个事件' : '等待请求'}</small></div><Badge appearance="tint" color={events.some((item) => item.level === 'error') ? 'danger' : 'informative'}>{busy ? '实时' : '完整轨迹'}</Badge></div>
          <EventTimeline events={events} />
        </Card>
      </div>
    </Card>
  </section>;
}


function Placeholder({ title, text, icon }: { title: string; text: string; icon: React.ReactNode }) { return <section className="module-page"><div className="section-title"><div><Text className="eyebrow">控制平面</Text><h1>{title}</h1><p>{text}</p></div></div><Card className="coming-card">{icon}<h2>模块骨架已就绪</h2><p>该模块将使用与仪表盘相同的请求、模型和审计数据源，避免形成孤立的管理功能。</p></Card></section>; }

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [page, setPage] = useState<Page>(pageFromHash);
  const [dark, setDark] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [logs, setLogs] = useState<Log[]>([]);
  const [models, setModels] = useState<Array<{ id: string; provider: string }>>([]);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const load = async () => {
    try {
      const nextUser = await api<SessionUser>('/api/auth/me');
      setUser(nextUser);
      setAuthenticated(true);
      const [nextDashboard, nextAccounts, nextLogs, nextModels] = await Promise.all([
        api<Dashboard>('/api/dashboard'),
        api<Account[]>('/api/accounts'),
        api<Log[]>('/api/logs'),
        api<Array<{ id: string; provider: string }>>('/api/catalog/models'),
      ]);
      setDashboard(nextDashboard);
      setAccounts(nextAccounts);
      setLogs(nextLogs);
      setModels(nextModels);
    } catch {
      setUser(null);
      setAuthenticated(false);
    }
  };

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    setUser(null);
    setAuthenticated(false);
  }

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    const syncPage = () => {
      setPage(pageFromHash());
      setMobileNavOpen(false);
    };
    if (!window.location.hash) window.history.replaceState(null, '', '#overview');
    window.addEventListener('hashchange', syncPage);
    return () => window.removeEventListener('hashchange', syncPage);
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle('a2a-light', !dark);
    return () => document.documentElement.classList.remove('a2a-light');
  }, [dark]);

  const navigate = useCallback((next: Page) => {
    setMobileNavOpen(false);
    if (window.location.hash === `#${next}`) setPage(next);
    else window.location.hash = next;
  }, []);

  const content = useMemo(() => {
    if (page === 'overview') return <Overview dashboard={dashboard} logs={logs} onPage={navigate} />;
    if (page === 'accounts') return <AccountPoolPage accounts={accounts} refresh={() => void load()} />;
    if (page === 'test') return <TestConsole models={models} accounts={accounts} />;
    if (page === 'keys') return <KeysPage />;
    if (page === 'routing') return <RoutesPage />;
    if (page === 'users') return <UsersPage />;
    if (page === 'analytics') return <AnalyticsPage />;
    if (page === 'logs') return <LiveLogsPage logs={logs} refresh={() => void load()} />;
    if (page === 'images') return <ImageLogsPage />;
    return <GuidePage />;
  }, [page, dashboard, logs, accounts, models, navigate]);

  if (authenticated === null) return <div className="boot"><Spinner label="正在加载控制台…" /></div>;
  if (!authenticated) return <FluentProvider theme={dark ? webDarkTheme : webLightTheme}><Login onSuccess={() => void load()} /></FluentProvider>;

  return (
    <FluentProvider theme={dark ? webDarkTheme : webLightTheme}>
      <div className={`app-shell ${dark ? 'dark' : 'light'}`}>
        {/* 移动端抽屉遮罩 */}
        <div
          className={`sidebar-backdrop ${mobileNavOpen ? 'open' : ''}`}
          onClick={() => setMobileNavOpen(false)}
          aria-hidden="true"
        />

        {/* 侧边栏 / 移动端抽屉 */}
        <aside className={`sidebar ${mobileNavOpen ? 'mobile-open' : ''}`}>
          <div className="sidebar-header-row">
            <a className="logo" href="#overview" onClick={(event) => { event.preventDefault(); navigate('overview'); }}>
              <span className="brand-mark"><Bot24Regular /></span>
              <span>Any2API<small>CONTROL PLANE</small></span>
            </a>
            <button
              type="button"
              className="sidebar-close-btn"
              onClick={() => setMobileNavOpen(false)}
              aria-label="关闭导航菜单"
            >
              <DismissIcon />
            </button>
          </div>
          <nav>
            {nav.map((item) => (
              <button
                key={item.id}
                className={`nav-item ${page === item.id ? 'active' : ''}`}
                onClick={() => navigate(item.id)}
              >
                {item.icon}
                <span>{item.label}</span>
                {page === item.id ? <span className="nav-active" /> : null}
              </button>
            ))}
          </nav>
        </aside>

        {/* 主内容区域 */}
        <main className="main">
          <header className="topbar">
            <div className="topbar-left">
              <button
                type="button"
                className="hamburger-btn"
                onClick={() => setMobileNavOpen((v) => !v)}
                aria-label="打开导航菜单"
              >
                <MenuIcon />
              </button>
              <Text className="topbar-label">ANY2API / {nav.find((item) => item.id === page)?.label}</Text>
            </div>
            <div className="topbar-actions topbar-user-actions">
              <span className="user-avatar">{(user?.username ?? 'U').slice(0, 1).toUpperCase()}</span>
              <span className="topbar-user-copy">
                <strong>{user?.username ?? '—'}</strong>
                <small>{labelFor(roleLabels, user?.role)}</small>
              </span>
              <Tooltip content={dark ? '切换为浅色主题' : '切换为深色主题'} relationship="label">
                <Button appearance="subtle" icon={dark ? <Lightbulb24Regular /> : <DarkTheme24Regular />} aria-label="切换主题" onClick={() => setDark((value) => !value)} />
              </Tooltip>
              <Tooltip content="退出登录" relationship="label">
                <Button appearance="subtle" icon={<LogoutIcon />} aria-label="退出登录" onClick={() => void logout()} />
              </Tooltip>
            </div>
          </header>
          <div className="content">{content}</div>
        </main>
      </div>
    </FluentProvider>
  );
}
