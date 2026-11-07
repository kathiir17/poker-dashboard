// ══════════════ STATS CALCULATIONS ══════════════
// Pure functions: they read data and return numbers, and never touch the page or the database.
// index.html and test.html both load this file (a plain script, so everything here is a global).
//
// Most functions take a list of sessions from selectSessions(), so the same code works for one
// season, a whole chapter, or All time. Each session in that list looks like:
//   {id, seq, name, date:"DD/MM/YYYY", results:[{player, buyin, final}],
//    chapter:1|2, season:<number>, seasonName:"Season 2", t:<day number>, order:<0,1,2…>}

const K=3;   // shrinkage: score = total PnL ÷ (sessions played + K)
const EPS=0.004;   // amounts closer than this (under half a penny) count as equal

// A result's profit or loss, rounded to the penny so float noise (0.1+0.2) never matters
function pnl(r){return Math.round((r.final-r.buyin)*100)/100;}

// "DD/MM/YYYY" → whole days since 1970 (for date order and chart spacing)
function dayNum(date){const [d,m,y]=date.split('/').map(Number);return Math.round(Date.UTC(y,m-1,d)/864e5);}

// Sessions for a selection, oldest first, each tagged with its chapter and season.
//   view: 'era-1' | 'era-2' | 'all'    seasonNumber: a season's number, or -1 for all seasons
// Order: date, then chapter, season, and the order sessions were added (seq).
function selectSessions(data,view,seasonNumber){
  const eras=view==='all'?['era-1','era-2']:[view];
  const out=[];
  eras.forEach(eraId=>{
    const chapter=eraId==='era-1'?1:2;
    data.eras[eraId].seasons.forEach(se=>{
      if(seasonNumber!==-1&&se.number!==seasonNumber)return;
      se.sessions.forEach(s=>out.push({...s,chapter,season:se.number,seasonName:se.name,t:dayNum(s.date)}));
    });
  });
  out.sort((a,b)=>a.t-b.t||a.chapter-b.chapter||a.season-b.season||(a.seq||0)-(b.seq||0));
  out.forEach((s,i)=>s.order=i);
  return out;
}

// Short labels: "C2 S2" and "C2 · S2 · Session 1"
function seasonTag(s){return `C${s.chapter} S${s.season}`;}
function sessionTag(s){return `C${s.chapter} · S${s.season} · ${s.name}`;}

// Per player, sorted by rank (best shrunk average first):
//   {name, rank, n, pnlTot, shrunk, rawAvg, buyin, out, inProfit, topped,
//    best:{pnl, session}, worst:{pnl, session}}
// inProfit = sessions with PnL > 0. topped = sessions where they had the highest PnL
// (everyone tied for the top gets it).
function playerStats(sessions){
  const m={};
  sessions.forEach(s=>{
    const top=Math.max(...s.results.map(pnl));
    s.results.forEach(r=>{
      const p=pnl(r);
      const e=m[r.player]||(m[r.player]={name:r.player,n:0,pnlTot:0,buyin:0,out:0,inProfit:0,topped:0,best:null,worst:null});
      e.n++; e.pnlTot+=p; e.buyin+=r.buyin; e.out+=r.final;
      if(p>EPS)e.inProfit++;
      if(p>=top-EPS)e.topped++;
      if(!e.best||p>e.best.pnl)e.best={pnl:p,session:s};
      if(!e.worst||p<e.worst.pnl)e.worst={pnl:p,session:s};
    });
  });
  const all=Object.values(m);
  all.forEach(e=>{e.pnlTot=Math.round(e.pnlTot*100)/100;e.shrunk=e.pnlTot/(e.n+K);e.rawAvg=e.pnlTot/e.n;});
  all.sort((a,b)=>b.shrunk-a.shrunk||a.name.localeCompare(b.name));
  all.forEach((e,i)=>e.rank=i+1);
  return all;
}

// Running total (cumulative PnL) per player: {name: [{session, total}]}, one point for each
// session they played, in order. The chart draws each line from these points.
function runningTotals(sessions){
  const lines={},sum={};
  sessions.forEach(s=>s.results.forEach(r=>{
    sum[r.player]=Math.round(((sum[r.player]||0)+pnl(r))*100)/100;
    (lines[r.player]||(lines[r.player]=[])).push({session:s,total:sum[r.player]});
  }));
  return lines;
}

// Each player's PnL in every session they played, in order: {name: [{session, pnl}]}
// (the "Per session" chart)
function sessionPnls(sessions){
  const out={};
  sessions.forEach(s=>s.results.forEach(r=>(out[r.player]||(out[r.player]=[])).push({session:s,pnl:pnl(r)})));
  return out;
}

// The working behind one rivals() number: every session players a and b both played, oldest first:
//   [{session, a:{buyin, final, pnl}, b:{buyin, final, pnl}, gap}]   gap = a's PnL − b's PnL
// The average of the gaps is the pair's number in rivals().
function sharedSessions(sessions,a,b){
  const out=[];
  sessions.forEach(s=>{
    const ra=s.results.find(r=>r.player===a),rb=s.results.find(r=>r.player===b);
    if(!ra||!rb)return;
    const A={buyin:ra.buyin,final:ra.final,pnl:pnl(ra)},B={buyin:rb.buyin,final:rb.final,pnl:pnl(rb)};
    out.push({session:s,a:A,b:B,gap:Math.round((A.pnl-B.pnl)*100)/100});
  });
  return out;
}

// Rivals: for each player, every opponent they've shared at least minShared sessions with:
//   {player: [{opp, avg, n}]}, avg = average of (my PnL − their PnL) per shared session,
//   so positive means the player usually beats that opponent. Sorted worst rival first.
function rivals(sessions,minShared=3){
  const acc={};
  sessions.forEach(s=>s.results.forEach(a=>s.results.forEach(b=>{
    if(a.player===b.player)return;
    const row=acc[a.player]||(acc[a.player]={});
    const e=row[b.player]||(row[b.player]={opp:b.player,sum:0,n:0});
    e.sum+=pnl(a)-pnl(b); e.n++;
  })));
  const out={};
  Object.entries(acc).forEach(([p,row])=>{
    const list=Object.values(row).filter(e=>e.n>=minShared).map(e=>({opp:e.opp,avg:e.sum/e.n,n:e.n}));
    if(list.length)out[p]=list.sort((a,b)=>a.avg-b.avg||a.opp.localeCompare(b.opp));
  });
  return out;
}

// Headlines for a selection: best and worst single session (ties: the earliest),
// money in play (total buy-ins), and how many sessions and players.
function headlines(sessions){
  let best=null,worst=null,money=0;const players=new Set();
  sessions.forEach(s=>s.results.forEach(r=>{
    const p=pnl(r);money+=r.buyin;players.add(r.player);
    if(!best||p>best.pnl)best={pnl:p,player:r.player,session:s};
    if(!worst||p<worst.pnl)worst={pnl:p,player:r.player,session:s};
  }));
  return {best,worst,money:Math.round(money*100)/100,sessions:sessions.length,players:players.size};
}

// ══════════════ AWARDS ══════════════
// Worked out per season from the results; never entered by hand. A season's awards are locked once
// a newer season exists; the current (newest) season's are "leading" and can still change.
// Ties: everyone tied gets the award.
//
// Each award: {type, chapter, season, seasonName, players:[names], value, status:'locked'|'leading', ...extra}
//   champion / runnerUp / third / loser  value = shrunk average. Places use sports-style ranking (1, 1, 3:
//                                        two tied champions means no runner-up). Last place wins over a
//                                        podium place, so with 3 players the bottom one is Loser, not Third.
//   donation   worst single-session PnL (value), with who did it in which session (donors:[{player, session}])
//   ironMan    played every session (value = how many sessions). Can be several people, or nobody.
//   comeback   biggest rise in average PnL from the first half of the season to the second
//              (value = second-half average − first-half average, must be above 0), with before/after.
//              Halves are by session order; with an odd number the middle session goes in the second
//              half. Only players with 2+ sessions in each half count.
//   falloff    the same, biggest fall (value below 0)
//   whale      most money bought in across the season (value = total buy-ins, rebuys included)
const AWARD_TYPES=['champion','runnerUp','third','loser','donation','ironMan','comeback','falloff','whale'];

function seasonAwards(data,eraId,seasonNumber){
  const ss=selectSessions(data,eraId,seasonNumber);
  if(!ss.length)return [];
  const chapter=eraId==='era-1'?1:2;
  const era2=data.eras['era-2'].seasons;
  const newest=era2.length?era2.reduce((a,b)=>b.number>a.number?b:a).number:null;
  const status=chapter===2&&seasonNumber===newest?'leading':'locked';
  const seasonName=data.eras[eraId].seasons.find(s=>s.number===seasonNumber).name;
  const out=[];
  const give=(type,players,value,extra={})=>{if(players.length)out.push({type,chapter,season:seasonNumber,seasonName,players,value,status,...extra});};
  const same=(a,b)=>Math.abs(a-b)<=EPS;

  // Standings places
  const ps=playerStats(ss);
  const placeOf=p=>ps.filter(x=>x.shrunk>p.shrunk+EPS).length+1;   // 1 + how many are strictly ahead
  const lastVal=ps.at(-1).shrunk;
  const isLast=p=>ps.length>1&&same(p.shrunk,lastVal)&&!same(lastVal,ps[0].shrunk);
  [['champion',1],['runnerUp',2],['third',3]].forEach(([type,place])=>{
    const who=ps.filter(p=>placeOf(p)===place&&!isLast(p));
    if(who.length)give(type,who.map(p=>p.name),who[0].shrunk);
  });
  const losers=ps.filter(isLast);
  if(losers.length)give('loser',losers.map(p=>p.name),lastVal);

  // Donation of the Season: worst single session
  const all=ss.flatMap(s=>s.results.map(r=>({player:r.player,pnl:pnl(r),session:s})));
  const worst=Math.min(...all.map(x=>x.pnl));
  const donors=all.filter(x=>same(x.pnl,worst));
  give('donation',[...new Set(donors.map(x=>x.player))],worst,{donors:donors.map(x=>({player:x.player,session:x.session}))});

  // Iron Man: played every session
  give('ironMan',ps.filter(p=>p.n===ss.length).map(p=>p.name),ss.length);

  // Comeback / Fall-off: first half vs second half
  const half=Math.floor(ss.length/2);
  const avgIn=(list,name)=>{const v=list.flatMap(s=>s.results.filter(r=>r.player===name).map(pnl));return v.length>=2?v.reduce((a,b)=>a+b,0)/v.length:null;};
  const swings=ps.map(p=>({name:p.name,before:avgIn(ss.slice(0,half),p.name),after:avgIn(ss.slice(half),p.name)}))
    .filter(x=>x.before!==null&&x.after!==null).map(x=>({...x,change:x.after-x.before}));
  if(swings.length){
    const up=Math.max(...swings.map(x=>x.change)),down=Math.min(...swings.map(x=>x.change));
    const pick=v=>swings.filter(x=>same(x.change,v));
    if(up>EPS)give('comeback',pick(up).map(x=>x.name),up,{swings:pick(up)});
    if(down<-EPS)give('falloff',pick(down).map(x=>x.name),down,{swings:pick(down)});
  }

  // Whale: most bought in
  const most=Math.max(...ps.map(p=>p.buyin));
  give('whale',ps.filter(p=>same(p.buyin,most)).map(p=>p.name),most);
  return out;
}

// Every award in every season, newest season first (then in AWARD_TYPES order)
function allAwards(data){
  const out=[];
  ['era-2','era-1'].forEach(eraId=>{
    [...data.eras[eraId].seasons].sort((a,b)=>b.number-a.number).forEach(se=>out.push(...seasonAwards(data,eraId,se.number)));
  });
  return out;
}
