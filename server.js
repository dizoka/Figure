const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE = 'https://vstup.osvita.ua';
const LIST_URL = `${BASE}/r4/309/`;
const SNAPSHOT = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'snapshot.json'), 'utf8'));
let cache = { at: 0, data: null };
const TTL = 1000 * 60 * 60;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/api/health', (_, res) => res.json({ ok:true }));
app.get('/api/offers', async (req, res) => {
  const refresh = req.query.refresh === '1';
  if (!refresh && cache.data && Date.now() - cache.at < TTL) return res.json(cache.data);
  try {
    const data = await loadLiveList();
    if (data.offers.length < 40) throw new Error(`live дав лише ${data.offers.length} пропозицій`);
    cache = { at: Date.now(), data };
    res.json(data);
  } catch (e) {
    const data = { ...SNAPSHOT, source:'embedded-osvita-snapshot', warning:`Live Освіта.UA не відкрився на Render: ${e.message}`, fetchedAt:new Date().toISOString() };
    cache = { at: Date.now(), data };
    res.json(data);
  }
});

const http = axios.create({ timeout: 25000, validateStatus:s=>s>=200&&s<500, headers:{
  'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language':'uk-UA,uk;q=0.9,en-US;q=0.7,en;q=0.6',
  'Referer':'https://vstup.osvita.ua/',
  'Cache-Control':'no-cache'
}});
function clean(s){return String(s||'').replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').trim()}
function lines(html){const $=cheerio.load(html);$('script,style,noscript').remove();return $('body').text().split(/\n+/).map(clean).filter(Boolean)}
function num(s){const m=String(s||'').replace(',','.').match(/-?\d+(?:\.\d+)?/);return m?Number(m[0]):null}
async function fetchHtml(url){
  const urls=[url, `https://r.jina.ai/http://r.jina.ai/http://${url}`, `https://r.jina.ai/http://r.jina.ai/http://${url.replace(/^https?:\/\//,'')}`];
  let last='';
  for (const u of urls){
    try{ const r=await http.get(u); if(r.status===200 && String(r.data).length>1000) return String(r.data); last=`${r.status}`; }
    catch(e){ last=e.message; }
  }
  throw new Error(last || 'не вдалося завантажити');
}
function parseSpecLine(s){
  const t=clean(s.replace(/^Спеціальність:\s*/i,''));
  const m=t.match(/^([A-ZА-ЯІЇЄ]\d+(?:\.\d+)?)\s+(.+)$/u);
  return m?{code:m[1],specialty:m[2]}:{code:'',specialty:t};
}
function coeffsFromBlock(block, code){
  const text=block.join('\n');
  const get=(name)=>{const re=new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'[\\s\\S]{0,90}?k\\s*=\\s*([0-9]+(?:[.,][0-9]+)?)','iu'); const m=text.match(re); return m?Number(m[1].replace(',','.')):null}
  const fallback = (SNAPSHOT.offers.find(x=>x.code===code)||{}).coeffs || {ua:.3,math:.3,history:.3,foreign:.3,literature:.3,biology:.3,geography:.3,physics:.3,chemistry:.3,k4max:.3};
  const out={...fallback};
  out.ua=get('Українська мова') ?? out.ua;
  out.math=get('Математика') ?? out.math;
  out.history=get('Історія України') ?? out.history;
  out.literature=get('Українська література') ?? out.literature;
  out.foreign=get('Іноземна мова') ?? out.foreign;
  out.biology=get('Біологія') ?? out.biology;
  out.geography=get('Географія') ?? out.geography;
  out.physics=get('Фізика') ?? out.physics;
  out.chemistry=get('Хімія') ?? out.chemistry;
  out.k4max=Math.max(out.literature||0,out.foreign||0,out.biology||0,out.geography||0,out.physics||0,out.chemistry||0);
  return out;
}
function readAfter(block,label){const i=block.findIndex(x=>x.startsWith(label)); if(i<0)return ''; const same=block[i].replace(label,'').replace(/^:\s*/,'').trim(); return same || block[i+1] || ''}
async function loadLiveList(){
  const html=await fetchHtml(LIST_URL);
  const arr=lines(html);
  const offers=[];
  for(let i=0;i<arr.length;i++){
    if(arr[i] !== 'Бакалавр (на основі Повна загальна середня освіта)') continue;
    const block=[];
    for(let j=i;j<arr.length && j<i+120;j++){
      if(j>i && /^(Бакалавр|Магістр) \(на основі/.test(arr[j])) break;
      block.push(arr[j]);
    }
    const specLine=block.find(x=>x.startsWith('Спеціальність:'))||'';
    const {code,specialty}=parseSpecLine(specLine);
    if(!code) continue;
    const program=readAfter(block,'Освітня програма');
    const type=readAfter(block,'Тип пропозиції');
    const faculty=readAfter(block,'Факультет');
    const contract=num(readAfter(block,'Обсяг на контракт'));
    const maxState=num(readAfter(block,'Максимальний обсяг держ замовлення'));
    const minState=num(readAfter(block,'Мінімальний обсяг держ замовлення'));
    const avgBudget=num((block.find(x=>x.startsWith('Середній балЗНО на бюджет'))||''));
    const snap=SNAPSHOT.offers.find(x=>x.code===code && x.program===program) || SNAPSHOT.offers.find(x=>x.code===code);
    const budgetEligible=!/Небюджетна/i.test(type);
    offers.push({
      id:`live-${offers.length+1}`, code, specialty, program, form:'Денна', faculty, offerType:type, contract, maxState, minState,
      budgetEligible, url:LIST_URL, statsSource:LIST_URL,
      threshold: snap?.threshold ?? null, avgBudgetNmt2025:avgBudget,
      budgetPlaces:maxState ?? snap?.budgetPlaces ?? null,
      regionalCoef:1, industryCoef:snap?.industryCoef ?? (/^(A|E|G|H|J|K10)/.test(code)?1.02:1),
      coeffs: coeffsFromBlock(block, code), note: snap?.note || ''
    });
  }
  // merge snapshot offers that are absent in live; this keeps J8 separate variants even if list parsing missed forms/IDs
  const key=o=>`${o.code}|${o.program}|${o.form}`;
  const seen=new Set(offers.map(key));
  for(const o of SNAPSHOT.offers){ if(!seen.has(key(o))) offers.push(o); }
  offers.sort((a,b)=>(a.code||'').localeCompare(b.code||'','uk')||(a.program||'').localeCompare(b.program||'','uk')||(a.form||'').localeCompare(b.form||'','uk'));
  return { source:'live-osvita-list+snapshot-thresholds', fetchedAt:new Date().toISOString(), count:offers.length, offers };
}
app.listen(PORT,()=>console.log('LNTU calculator final on '+PORT));
