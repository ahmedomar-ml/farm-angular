'use strict';
// مصدر الحقيقة للصلاحيات والتحقق من البيانات (السيرفر هو اللي بيفرضها، مش الفرونت)
const MGR = 'مدير', ENG = 'مهندس', SUP = 'مشرف', WRK = 'عامل', VET = 'دكتور', ACC = 'محاسب', STK = 'أمين مخزن';
const ROLES = [MGR, ENG, SUP, WRK, VET, ACC, STK];

// من يقدر يوجّه ملاحظة لمين
const AUD = {
  [MGR]: ['الكل', 'العمال والمشرفين', 'العمال', 'المهندس'],
  [ENG]: ['العمال والمشرفين'], [SUP]: ['العمال', 'المهندس', 'المدير'],
  [VET]: ['المهندس والمدير'], [WRK]: [], [ACC]: ['المدير'], [STK]: ['المهندس والمدير'],
};
const AUDV = {
  'الكل': ROLES, 'العمال': [WRK], 'العمال والمشرفين': [WRK, SUP],
  'المهندس': [ENG], 'المدير': [MGR], 'المهندس والمدير': [ENG, MGR],
};

const date = { k: 'date', t: 'date' }, house = { k: 'house', t: 'select', o: '@houses' }, note = { k: 'note' };
const receipt = { k: 'receipt', t: 'file' }, io = { k: 'type', t: 'select', o: ['وارد', 'صادر'] };
const emp = { k: 'emp', t: 'select', o: 'users' }, num = (k) => ({ k, t: 'number' });
const others = ROLES.filter(r => r !== MGR);
const all = (v) => Object.fromEntries(others.map(r => [r, v]));
const rd = (extra) => ({ ...all('r'), ...extra });

// p = الصلاحيات الافتراضية لكل وظيفة: r=عرض a=إضافة e=تعديل d=حذف (المدير له كل شيء، ويعدّلها من تبويب الصلاحيات)
const M = {
  cycles: { p: rd({ [ENG]: 'rae' }), f: [{ k: 'name' }, { k: 'vet' }, { k: 'start', t: 'date' }, num('count'), { k: 'status', t: 'select', o: ['جارية', 'منتهية'] }] },
  users: { p: { [ENG]: 'raed', [ACC]: 'r' }, f: [] },
  attendance: { p: { [ENG]: 'r', [SUP]: 'r', [ACC]: 'r' }, f: [emp, date, { k: 'st', t: 'select', o: ['حضور', 'غياب', 'إجازة'] }] },
  deduct: { p: { [ENG]: 'raed', [ACC]: 'raed' }, f: [emp, date, num('amt'), { k: 'reason' }] },
  adv: { p: { [ACC]: 'raed' }, f: [emp, date, num('amt'), note] },
  leave: { p: { [ENG]: 'r', [SUP]: 'r', [ACC]: 'r' }, f: [emp, { k: 'from', t: 'date' }, { k: 'to', t: 'date' },
    { k: 'kind', t: 'select', o: ['اعتيادية', 'مرضية', 'عارضة', 'بدون أجر'] }, { k: 'st', t: 'select', o: ['معلقة', 'موافق', 'مرفوضة'] }] },
  feed: { scoped: true, p: { [ENG]: 'raed', [SUP]: 'ra', [WRK]: 'ra', [VET]: 'r', [STK]: 'raed', [ACC]: 'r' },
    f: [date, house, { ...io, wo: ['صادر'] }, { k: 'kind' }, num('qty'), receipt, note] },
  dead: { scoped: true, p: { [ENG]: 'raed', [SUP]: 'ra', [WRK]: 'ra', [VET]: 'r', [ACC]: 'r' },
    f: [date, house, { k: 'cyc', t: 'select', o: 'cycles' }, num('n'), { k: 'cause' }] },
  gas: { scoped: true, p: { [ENG]: 'raed', [SUP]: 'ra', [STK]: 'r', [ACC]: 'r' }, f: [date, house, num('qty'), note] },
  water: { scoped: true, p: { [ENG]: 'raed', [SUP]: 'ra', [STK]: 'r', [ACC]: 'r' }, f: [date, house, num('qty'), note] },
  meds: { p: { [ENG]: 'raed', [SUP]: 'ra', [VET]: 'r', [STK]: 'raed', [ACC]: 'r' }, f: [date, io, { k: 'name' }, num('qty'), receipt, note] },
  receipts: { p: { [ENG]: 'raed', [SUP]: 'ra', [STK]: 'raed', [ACC]: 'r' }, f: [date, { k: 'what' }, num('qty'), receipt, note] },
  vet: { p: { [VET]: 'raed', [ENG]: 'r', [ACC]: 'r' }, f: [date, { k: 'kind', t: 'select', o: ['جلب دواء', 'إرجاع دواء', 'زيارة'] },
    { k: 'name' }, num('qty'), num('price'), num('birds'), note] },
  notes: { aud: true, p: { [ENG]: 'ra', [SUP]: 'ra', [VET]: 'ra', [WRK]: 'r', [ACC]: 'ra', [STK]: 'ra' },
    f: [date, { k: 'to', t: 'select', o: '@aud' }, { k: 'text' }] },
  complaints: { p: all('a'), f: [date, { k: 'text' }] },
  shifts: { p: rd({ [ENG]: 'raed' }), f: [emp, date, { k: 'shift', t: 'select', o: ['صباحي', 'مسائي'] }] },
  kitchen: { p: rd({}), f: [{ k: 'name' }, { k: 'job', t: 'select', o: ['طباخ', 'مساعد'] }] },
  meals: { p: { [ENG]: 'ra', [SUP]: 'ra', [WRK]: 'ra', [VET]: 'r', [ACC]: 'r', [STK]: 'ra' },
    f: [date, { k: 'meal' }, { k: 'avail', t: 'select', o: ['متاح', 'خلص'] }, note] },
  votes: { p: all('ra'), f: [date, { k: 'meal' }, { k: 'taste', t: 'select', o: ['مالح', 'عادي', 'مسكر', 'حلو', 'وحش'] }, { k: 'want' }, note] },
  payments: { p: { [ACC]: 'r' }, f: [emp, { k: 'month' }, num('days'), num('gross'), num('ded'), num('adv'), num('net'), date] },
  vaccines: { p: { [ENG]: 'raed', [VET]: 'raed', [SUP]: 'r', [ACC]: 'r' }, f: [{ k: 'name' }, num('day'), { k: 'done', t: 'select', o: ['لم يتم', 'تم'] }, note] },
  cams: { p: {}, f: [{ k: 'name' }, { k: 'loc' }, { k: 'url' }, { k: 'kind', t: 'select', o: ['صفحة (iframe)', 'صورة / MJPEG'] }] },
};
module.exports = { MGR, ENG, SUP, WRK, VET, ACC, STK, ROLES, AUD, AUDV, M };
