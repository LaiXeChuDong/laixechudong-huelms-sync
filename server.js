const express = require('express');
const { chromium } = require('playwright');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' }));
const PORT = Number(process.env.PORT || 3000);
const SECRET = String(process.env.THEORY_SYNC_SECRET || '');
const BASE_URL = String(process.env.HUELMS_BASE_URL || 'https://vietmy.huelms.com').replace(/\/$/, '');
const DEFAULT_PASSWORD = String(process.env.HUELMS_DEFAULT_PASSWORD || '');
const jobs = new Map();

function assertSecret(value) {
  if (!SECRET || !value || value !== SECRET) throw new Error('UNAUTHORIZED');
}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function score(v){ const m=String(v||'').replace(',','.').match(/-?\d+(?:\.\d+)?/); return m?Number(m[0]):0; }
function norm(s){ return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim(); }

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    try { if (await loc.count() && await loc.isVisible()) return loc; } catch (_) {}
  }
  return null;
}

async function login(page, username, password) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const userInput = await firstVisible(page, [
    'input[name="username"]','input[name="userName"]','input[name="email"]','input[name="account"]',
    'input[placeholder*="tài khoản" i]','input[placeholder*="username" i]','input[type="text"]'
  ]);
  const passInput = await firstVisible(page, ['input[name="password"]','input[type="password"]']);
  if (!userInput || !passInput) throw new Error('Không tìm thấy form đăng nhập HueLMS. Cần hiệu chỉnh selector.');
  await userInput.fill(username);
  await passInput.fill(password);
  const button = await firstVisible(page, ['button:has-text("Đăng nhập")','button:has-text("Login")','input[type="submit"]','button[type="submit"]']);
  if (!button) throw new Error('Không tìm thấy nút Đăng nhập HueLMS.');
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}), button.click()]);
  await page.waitForTimeout(1200);
  const body = norm(await page.locator('body').innerText().catch(()=>''));
  if (body.includes('sai mat khau') || body.includes('khong dung') || body.includes('dang nhap that bai')) throw new Error('Sai tài khoản hoặc mật khẩu HueLMS.');
}

async function openProgressPage(page) {
  if ((await page.locator('text=Bảng điểm khoá học').count()) || (await page.locator('text=Bảng điểm khóa học').count())) return;
  const direct = page.locator('a[href*="/student/ep/"]').first();
  if (await direct.count()) {
    await direct.click(); await page.waitForLoadState('domcontentloaded').catch(()=>{}); return;
  }
  const candidates = [
    'a:has-text("Chương trình đào tạo")','a:has-text("Khóa học")','a:has-text("Khoá học")',
    'a:has-text("Tiến độ")','a:has-text("Kết quả")','button:has-text("Chi tiết")'
  ];
  for (const selector of candidates) {
    const loc=page.locator(selector).first();
    if (await loc.count()) { try { await loc.click(); await page.waitForTimeout(900); } catch(_){} const next=page.locator('a[href*="/student/ep/"]').first(); if(await next.count()){await next.click();await page.waitForLoadState('domcontentloaded').catch(()=>{});return;} }
  }
  if (!((await page.locator('text=Bảng điểm khoá học').count()) || (await page.locator('text=Bảng điểm khóa học').count()))) {
    throw new Error('Không tìm thấy trang Bảng điểm khóa học. Cần hiệu chỉnh đường dẫn HueLMS một lần.');
  }
}

async function scrapeScores(page) {
  const rows = await page.locator('table tr').evaluateAll(trs => trs.map(tr => Array.from(tr.querySelectorAll('th,td')).map(td => (td.innerText||'').trim()).filter(Boolean)));
  const scores = { ethics:0, drivingTechnique:0, vehicleStructure:0, trafficLaw:0, pl1:0, pl2:0, pl3:0, simulation:0 };
  for (const cells of rows) {
    if (!cells.length) continue;
    const label = norm(cells[0]);
    const value = score(cells[cells.length - 1]);
    if (label.includes('dao duc') && label.includes('pccc')) scores.ethics=value;
    else if (label.includes('ky thuat lai xe')) scores.drivingTechnique=value;
    else if (label.includes('cau tao') && label.includes('sua chua')) scores.vehicleStructure=value;
    else if (label.includes('phap luat gtdb')) scores.trafficLaw=value;
    else if (label.startsWith('pl1')) scores.pl1=value;
    else if (label.startsWith('pl2')) scores.pl2=value;
    else if (label.startsWith('pl3')) scores.pl3=value;
    else if (label.includes('mo phong')) scores.simulation=value;
  }
  return scores;
}
function deriveStatus(scores){ const vals=Object.values(scores); if(vals.length && vals.every(v=>Number(v)>=100)) return 'Hoàn thành'; if(vals.some(v=>Number(v)>0)) return 'Đang học'; return 'Chưa học'; }

async function syncStudent(browser, student) {
  const context = await browser.newContext({ viewport:{width:1365,height:900}, locale:'vi-VN' });
  const page = await context.newPage();
  try {
    await login(page, String(student.cccd||'').trim(), DEFAULT_PASSWORD);
    await openProgressPage(page);
    const scores = await scrapeScores(page);
    return { ...student, scores, status: deriveStatus(scores), error:'' };
  } catch (e) {
    return { ...student, scores:{}, status:'Lỗi đồng bộ', error:e && e.message ? e.message : String(e) };
  } finally { await context.close(); }
}

async function callback(url, jobId, result) {
  const body = new URLSearchParams();
  body.set('data', JSON.stringify({ action:'theory.workerCallback', secret:SECRET, jobId, result }));
  const res = await fetch(url, { method:'POST', headers:{'content-type':'application/x-www-form-urlencoded;charset=UTF-8'}, body });
  if (!res.ok) throw new Error('Callback HTTP '+res.status);
}

async function runJob(job) {
  let browser;
  try {
    if (!DEFAULT_PASSWORD) throw new Error('Thiếu HUELMS_DEFAULT_PASSWORD trên worker.');
    browser = await chromium.launch({ headless:true, args:['--no-sandbox'] });
    job.status='running';
    for (let i=0;i<job.students.length;i++) {
      const result = await syncStudent(browser, job.students[i]);
      await callback(job.callbackUrl, job.id, result).catch(err=>{ result.callbackError=err.message; });
      job.processed=i+1;
      if (result.error) job.errors++;
      await sleep(job.delayMs);
    }
    job.status='done';
  } catch(e) { job.status='failed'; job.error=e.message||String(e); }
  finally { if(browser) await browser.close().catch(()=>{}); job.finishedAt=new Date().toISOString(); }
}

app.get('/health', (req,res)=>res.json({ok:true,service:'huelms-sync'}));
app.post('/jobs', (req,res)=>{
  try {
    assertSecret(req.body.secret);
    if (!req.body.callbackUrl) return res.status(400).json({error:'Thiếu callbackUrl'});
    const students = Array.isArray(req.body.students)?req.body.students.filter(s=>s&&s.cccd):[];
    if (!students.length) return res.status(400).json({error:'Không có học viên hợp lệ'});
    if (students.length > 20) return res.status(400).json({error:'Chế độ bán tự động hỗ trợ tối đa 20 học viên/lần'});
    const id=crypto.randomUUID();
    const delayMs=Math.max(1200,Math.min(5000,Number(req.body.delayMs||1800)));
    const job={id,status:'queued',processed:0,errors:0,total:students.length,students,callbackUrl:req.body.callbackUrl,delayMs,createdAt:new Date().toISOString()};
    jobs.set(id,job);
    setImmediate(()=>runJob(job));
    res.status(202).json({jobId:id,total:students.length,status:'queued'});
  } catch(e){ res.status(401).json({error:e.message||String(e)}); }
});
app.get('/jobs/:id',(req,res)=>{
  try {
    assertSecret(String(req.get('X-Theory-Secret')||''));
    const job=jobs.get(req.params.id);
    if(!job)return res.status(404).json({error:'Không tìm thấy job'});
    res.json({id:job.id,status:job.status,processed:job.processed,total:job.total,errors:job.errors,error:job.error||'',createdAt:job.createdAt,finishedAt:job.finishedAt||''});
  } catch(e){ res.status(401).json({error:e.message||String(e)}); }
});

app.listen(PORT,()=>console.log(`HueLMS sync worker listening on :${PORT}`));
