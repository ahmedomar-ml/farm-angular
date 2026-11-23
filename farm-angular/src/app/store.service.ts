import { Injectable } from '@angular/core';

// لو الفرونت على استضافة منفصلة عن السيرفر، اكتب هنا رابط السيرفر (مثال: 'https://farm.example.com')
export const API_BASE = '';

@Injectable({ providedIn: 'root' })
export class StoreService {
  token: string | null = localStorage.getItem('farm_token');
  status: 'loading' | 'ready' | 'login' | 'offline' = this.token ? 'loading' : 'login';
  me: any = null;
  data: Record<string, any[]> = {};
  perms: Record<string, string> = {};
  matrix: Record<string, Record<string, string>> = {};
  staff: string[] = [];
  houses: string[] = [];

  constructor() { if (this.token) { this.load(); } }

  async call(method: string, path: string, body?: any): Promise<any> {
    let res: Response;
    try {
      res = await fetch(API_BASE + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      if (!this.me) { this.status = 'offline'; }
      throw new Error('تعذر الاتصال بالسيرفر');
    }
    const j = await res.json().catch(() => ({}));
    if (res.status === 401 && this.token) { this.clear(); }
    if (!res.ok) { throw new Error(j.error || 'حدث خطأ'); }
    return j;
  }

  private setToken(t: string): void { this.token = t; localStorage.setItem('farm_token', t); }
  private clear(): void { this.token = null; this.me = null; localStorage.removeItem('farm_token'); this.status = 'login'; }

  async load(): Promise<void> {
    try {
      const j = await this.call('GET', '/api/data');
      this.me = j.me; this.data = j.data; this.perms = j.perms; this.matrix = j.matrix || {};
      this.staff = j.staff; this.houses = j.houses; this.status = 'ready';
    } catch { /* الحالة اتظبطت في call */ }
  }
  async login(phone: string, password: string): Promise<void> {
    this.token = null;
    const j = await this.call('POST', '/api/login', { phone, password });
    this.setToken(j.token); await this.load();
  }
  async register(b: any): Promise<void> {
    this.token = null;
    const j = await this.call('POST', '/api/register', b);
    this.setToken(j.token); await this.load();
  }
  async logout(): Promise<void> {
    try { await this.call('POST', '/api/logout'); } catch { /* ignore */ }
    this.clear();
  }
  async save(k: string, rec: any): Promise<void> {
    const { id, ...body } = rec;
    if (id) { await this.call('PUT', `/api/rec/${k}/${id}`, body); } else { await this.call('POST', `/api/rec/${k}`, body); }
    await this.load();
  }
  async remove(k: string, id: string): Promise<void> { await this.call('DELETE', `/api/rec/${k}/${id}`); await this.load(); }
  async setPerm(mod: string, role: string, p: string): Promise<void> { await this.call('PUT', '/api/perms', { mod, role, p }); await this.load(); }
}
