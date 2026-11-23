import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ACC, AUD, Field, M, MGR, PERMS, ROLES, WRK } from './config';
import { API_BASE, StoreService } from './store.service';

@Component({ selector: 'app-root', standalone: true, imports: [FormsModule], templateUrl: './app.component.html' })
export class AppComponent {
  M = M; MGR = MGR; PERMS = PERMS;
  keys = Object.keys(M);
  roles2 = ROLES.filter(r => r !== MGR);
  cur = 'home';
  mode: 'login' | 'register' = 'login';
  edit: { k: string; id?: string } | null = null;
  form: any = {};
  lg = { phone: '', pw: '' };
  rg = { farm: '', name: '', phone: '', pw: '' };
  err = '';
  busy = false;
  pm = new Date().toISOString().slice(0, 7);
  private urls = new Map<string, SafeResourceUrl>();
  ag: any = null;
  agForm: any = {};
  q = { text: '', a: '' };
  settingDefs = [
    { k: 'mortality_pct', l: 'حد النافق اليومي (%)' }, { k: 'feed_days', l: 'تنبيه لو العلف يكفي أقل من (يوم)' },
    { k: 'med_min', l: 'حد أدنى لرصيد الدواء' }, { k: 'attendance_hour', l: 'ساعة فحص الحضور (0-23)' },
    { k: 'payroll_day', l: 'يوم تجهيز الرواتب من الشهر' }, { k: 'vacc_days_ahead', l: 'تنبيه التحصين قبلها بـ (يوم)' },
  ];

  constructor(public s: StoreService, private san: DomSanitizer) {}

  // ---------- مساعدات ----------
  get me(): any { return this.s.me; }
  d(k: string): any[] { return this.s.data[k] || []; }
  v(k: string): any[] { return this.d(k); } // السيرفر بيفلتر الداتا حسب الصلاحية والعنبر
  today(): string { return new Date().toISOString().slice(0, 10); }
  fmt(n: any): string { return Number(n || 0).toLocaleString('ar-EG'); }
  sum(a: any[], k: string): number { return a.reduce((t, x) => t + (+x[k] || 0), 0); }
  safe(url: string): SafeResourceUrl {
    if (!this.urls.has(url)) { this.urls.set(url, this.san.bypassSecurityTrustResourceUrl(url)); }
    return this.urls.get(url) as SafeResourceUrl;
  }
  private async run(fn: () => Promise<void>): Promise<boolean> {
    this.busy = true;
    try { await fn(); return true; }
    catch (e: any) { alert(e?.message || 'حدث خطأ'); return false; }
    finally { this.busy = false; }
  }

  // ---------- الدخول ----------
  async doLogin(): Promise<void> {
    this.err = ''; this.busy = true;
    try { await this.s.login(this.lg.phone, this.lg.pw); this.cur = 'home'; this.lg.pw = ''; }
    catch (e: any) { this.err = e?.message || 'حدث خطأ'; }
    finally { this.busy = false; }
  }
  async doRegister(): Promise<void> {
    this.err = ''; this.busy = true;
    try {
      await this.s.register({ farmName: this.rg.farm, name: this.rg.name, phone: this.rg.phone, password: this.rg.pw });
      this.cur = 'home'; this.rg.pw = '';
    } catch (e: any) { this.err = e?.message || 'حدث خطأ'; }
    finally { this.busy = false; }
  }
  logout(): void { this.s.logout(); }

  // ---------- الصلاحيات (السيرفر هو اللي بيفرضها، دي لإخفاء الأزرار بس) ----------
  can(k: string, p: string): boolean { return (this.s.perms[k] || '').includes(p); }
  has(k: string, r: string, p: string): boolean { return (this.s.matrix[k]?.[r] || '').includes(p); }
  toggle(k: string, r: string, p: string): void {
    const c = this.s.matrix[k]?.[r] || '';
    this.run(() => this.s.setPerm(k, r, c.includes(p) ? c.replace(p, '') : c + p));
  }
  get tabs(): { k: string; t: string }[] {
    const t = this.keys.filter(k => this.can(k, 'r') || this.can(k, 'a')).map(k => ({ k, t: M[k].t }));
    const r = this.me?.role;
    if (this.can('agents', 'r')) { t.push({ k: 'agents', t: '🤖 الوكلاء' }); }
    if (r === MGR || r === ACC) { t.push({ k: 'payroll', t: 'المرتبات' }); }
    if (r === MGR) { t.push({ k: 'perms', t: 'الصلاحيات' }); }
    return t;
  }

  // ---------- الوكلاء ----------
  go(k: string): void { this.cur = k; if (k === 'agents') { this.loadAgents(); } }
  stLabel(s: string): string { return s === 'pending' ? 'ينتظر قرارك' : s === 'approved' ? 'تمت الموافقة' : 'مرفوض'; }
  async loadAgents(): Promise<void> {
    await this.run(async () => { this.ag = await this.s.call('GET', '/api/agents'); this.agForm = { ...this.ag.settings }; });
  }
  async runAgents(): Promise<void> {
    const ok = await this.run(async () => { await this.s.call('POST', '/api/agents/run'); });
    if (ok) { await this.loadAgents(); }
  }
  async makePayroll(): Promise<void> {
    let msg = '';
    const ok = await this.run(async () => { const r = await this.s.call('POST', '/api/agents/payroll', { month: this.pm }); msg = r.message || ''; });
    if (ok) { alert(msg); await this.loadAgents(); }
  }
  async decide(p: any, decision: string): Promise<void> {
    const txt = decision === 'approved' ? (p.kind === 'payroll' ? 'اعتماد صرف الرواتب؟ هيتسجل الصرف.' : 'الموافقة على الشراء؟') : 'رفض المقترح؟';
    if (!confirm(txt)) { return; }
    const ok = await this.run(async () => { await this.s.call('POST', `/api/agents/proposals/${p.id}/decide`, { decision }); await this.s.load(); });
    if (ok) { await this.loadAgents(); }
  }
  async setOn(key: string, ev: any): Promise<void> {
    await this.run(async () => { await this.s.call('PUT', '/api/agents/settings', { key: 'on_' + key, value: ev.target.checked ? '1' : '0' }); });
    await this.loadAgents();
  }
  async saveSettings(): Promise<void> {
    const ok = await this.run(async () => {
      for (const d of this.settingDefs) { await this.s.call('PUT', '/api/agents/settings', { key: d.k, value: String(this.agForm[d.k]) }); }
    });
    if (ok) { alert('تم الحفظ'); await this.loadAgents(); }
  }
  async askAgent(): Promise<void> {
    this.q.a = '';
    await this.run(async () => { const r = await this.s.call('POST', '/api/agents/ask', { question: this.q.text }); this.q.a = r.answer; });
  }

  rows(k: string): any[] {
    const key = (r: any) => String(r.date || r.from || r.start || '');
    return [...this.v(k)].sort((a, b) => key(b).localeCompare(key(a)));
  }
  cols(k: string): Field[] { return M[k].f.filter(f => f.t !== 'password'); }
  options(f: Field): string[] {
    const me = this.me;
    if (f.o === '@aud') { return AUD[me.role] || []; }
    if (f.o === '@houses') { return me.role === WRK ? [me.house || ''] : this.s.houses; }
    if (f.k === 'role' && this.edit?.k === 'users' && me.role !== MGR) { return [WRK]; }
    if (me.role === WRK && f.wo) { return f.wo; }
    if (f.o === 'users') { return this.s.staff; }
    return Array.isArray(f.o) ? f.o : this.d(f.o as string).map(x => x.name);
  }

  // ---------- الرئيسية ----------
  get active(): any { return this.d('cycles').filter(c => c.status === 'جارية').slice(-1)[0]; }
  get dead(): number {
    const a = this.active;
    return a ? this.sum(this.d('dead').filter(x => x.cyc === a.name), 'n') : 0;
  }
  deadToday(): number { return this.sum(this.v('dead').filter(x => x.date === this.today()), 'n'); }
  feed(type: string, onlyToday = false): number {
    return this.sum(this.v('feed').filter(x => x.type === type && (!onlyToday || x.date === this.today())), 'qty');
  }
  since(k: string, type?: string): number {
    const s = this.active?.start || '';
    return this.sum(this.d(k).filter(x => x.date >= s && (!type || x.type === type)), 'qty');
  }
  get meds(): { n: string; q: number }[] {
    const st: Record<string, number> = {};
    for (const x of this.d('meds')) { st[x.name] = (st[x.name] || 0) + (x.type === 'وارد' ? 1 : -1) * (+x.qty || 0); }
    return Object.keys(st).map(n => ({ n, q: st[n] }));
  }
  cnt(role: string): number { return this.d('users').filter(x => x.role === role && x.status !== 'منتهي').length; }
  get pendingLeaves(): number { return this.d('leave').filter(x => x.st === 'معلقة').length; }
  get todayMeals(): any[] { return this.d('meals').filter(x => x.date === this.today()); }

  // ---------- المرتبات ----------
  calc(u: any, month?: string): any {
    const inM = (x: any) => !month || String(x.date || x.from || '').startsWith(month);
    const att = (st: string) => this.d('attendance').filter(a => a.emp === u.name && a.st === st && inM(a)).length;
    const days = att('حضور'), leaves = att('إجازة'), absent = att('غياب');
    const ded = this.sum(this.d('deduct').filter(a => a.emp === u.name && inM(a)), 'amt');
    const adv = this.sum(this.d('adv').filter(a => a.emp === u.name && inM(a)), 'amt');
    const gross = days * (+u.wage || 0);
    return { days, leaves, absent, ded, adv, gross, net: gross - ded - adv };
  }
  get payrollRows(): any[] {
    return this.d('users').filter(u => u.status !== 'منتهي').map(u => ({ u, c: this.calc(u, this.pm) }));
  }
  mark(u: any, st: string): void {
    const t = this.today();
    if (this.d('attendance').some(a => a.emp === u.name && a.date === t)) { alert('تم تسجيل اليوم لـ ' + u.name); return; }
    this.run(() => this.s.save('attendance', { emp: u.name, date: t, st }));
  }
  async terminate(): Promise<void> {
    const u = this.d('users').find(x => x.id === this.edit?.id);
    if (!u || !confirm('إنهاء خدمة ' + u.name + '؟')) { return; }
    const c = this.calc(u);
    const ok = await this.run(() => this.s.save('users', { ...u, pass: '', status: 'منتهي', end: this.today() }));
    if (ok) {
      alert(`${u.name}\nأيام الشغل: ${c.days}\nأيام الإجازة: ${c.leaves}\nأيام الغياب: ${c.absent}\nالخصومات: ${c.ded}\nالسلف: ${c.adv}\nالمرتب النهائي: ${c.net}`);
      this.edit = null;
    }
  }
  async backup(): Promise<void> {
    await this.run(async () => {
      const res = await fetch(API_BASE + '/api/backup', { headers: { Authorization: 'Bearer ' + this.s.token } });
      if (!res.ok) { throw new Error('تعذر تنزيل النسخة'); }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a'); a.href = url; a.download = 'farm-backup.json'; a.click(); URL.revokeObjectURL(url);
    });
  }

  // ---------- النماذج ----------
  open(k: string, r?: any): void {
    const me = this.me;
    if (k === 'users' && me.role !== MGR && r && r.role !== WRK) { return; }
    this.edit = { k, id: r?.id };
    if (r) { this.form = { ...r, pass: '' }; return; }
    const o: any = {};
    for (const f of M[k].f) {
      o[f.k] = f.t === 'date' ? this.today() : f.t === 'number' ? 0 : f.t === 'select' ? (this.options(f)[0] ?? '') : '';
    }
    if (k === 'users') { o.role = WRK; o.status = 'يعمل'; }
    this.form = o;
  }
  pick(ev: any, key: string): void {
    const file = ev.target.files?.[0];
    if (!file) { return; }
    if (file.size > 500 * 1024) { alert('الصورة أكبر من 500 كيلو، صغّرها'); ev.target.value = ''; return; }
    const rd = new FileReader();
    rd.onload = () => { this.form[key] = rd.result; };
    rd.readAsDataURL(file);
  }
  async save(): Promise<void> {
    if (!this.edit) { return; }
    const ok = await this.run(() => this.s.save(this.edit!.k, { ...this.form, id: this.edit!.id }));
    if (ok) { this.edit = null; }
  }
  async remove(): Promise<void> {
    if (!this.edit?.id || !this.can(this.edit.k, 'd') || !confirm('حذف السجل؟')) { return; }
    const ok = await this.run(() => this.s.remove(this.edit!.k, this.edit!.id!));
    if (ok) { this.edit = null; }
  }
}
