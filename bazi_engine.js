/* ============================================================
 * 八字定量计算 —— 计分引擎（JS 版，分层）
 * 由 bazi_app/bazi.py 移植。排盘用 lunar-javascript（等价 lunar_python）。
 * 参数全部取自 BAZI_PARAMS（见 bazi_params.js）。
 *
 * 分层管线（按"处理步骤"分层；每层一个纯函数，各存一份数值、互不覆盖）：
 *   L0 干支     paipan → 四柱 + 司令
 *   L1 组成     天干100 + 藏干(渊海长生版)×柱位权重 → 五行初值 / 十神初值
 *   L2 旺衰     × 月令系数(由渊海月支组成推导) → 五行/十神力量
 *   L3 司令     月支组成改用三命通会司事表 → 重算五行/十神力量（L2 原值保留）
 *   L4 刑冲合害 检测刑冲合害(含距离+合化判定+宫位)；默认只标注，开关才修正数值
 *   L5 流通     相生环各边流量 + 断链/通关(通关取消克)；只产本层数值，不改浅层
 *
 * 对外：Bazi.run(pillars,{useSishi,upto}) → state（含各层数值）
 *       Bazi.layer.L1/L2/L3 可单跑；Bazi.analyze() 为兼容壳。
 * 暴露：globalThis.Bazi（浏览器）/ module.exports（node）
 * ============================================================ */
(function () {
  const P = (typeof module !== 'undefined' && module.exports)
    ? require('./bazi_params.js')
    : globalThis.BAZI_PARAMS;

  const SolarLib = (typeof module !== 'undefined' && module.exports)
    ? require('./lunar.js')
    : globalThis;

  const WUXING_ORDER = ['木', '火', '土', '金', '水'];
  const WUXING_RING = ['木', '火', '土', '金', '水']; // 相生环序（顺时针，母→子）
  const PILLAR_NAMES = ['年', '月', '日', '时'];

  // ════════════════════════════════════════════════════════════
  //  零、基础工具（与旧版一致）
  // ════════════════════════════════════════════════════════════

  // 待判五行 e 相对月令藏干五行 em 的旺衰状态
  function stateOf(e, em) {
    if (e === em) return '旺';
    if (P.SHENG[em] === e) return '相';   // 月令生我
    if (P.SHENG[e] === em) return '休';   // 我生月令
    if (P.KE[e] === em) return '囚';      // 我克月令
    return '死';                          // 月令克我
  }

  // 某支的有效藏干 [[干, 权重], ...]，权重合计 100
  function cangganOf(zhi, isMonth, useSishi) {
    if (isMonth && useSishi) {
      const lst = P.SISHI[zhi];
      const tot = lst.reduce((a, x) => a + x[1], 0) || 1;
      return lst.map((x) => [x[0], x[1] / tot * 100.0]);
    }
    return P.ZHI_CANGGAN[zhi];
  }

  // 月支本气干：司事模式取日数最多者，否则取藏干表首干
  function benqiGan(zhi, useSishi) {
    if (useSishi) {
      let best = P.SISHI[zhi][0];
      P.SISHI[zhi].forEach((x) => { if (x[1] > best[1]) best = x; });
      return best[0];
    }
    return P.ZHI_CANGGAN[zhi][0][0];
  }

  // 逐月五行系数表：coef(月支 M, 五行 E) = Σ 藏干 状态系数 × 权重/100
  const _coefCache = {};
  function monthCoefTable(useSishi) {
    const key = useSishi ? 'S' : 'B';
    if (_coefCache[key]) return _coefCache[key];
    const table = {};
    Object.keys(P.ZHI_CANGGAN).forEach((zhi) => {
      const row = {};
      WUXING_ORDER.forEach((e) => {
        let s = 0;
        cangganOf(zhi, true, useSishi).forEach((gw) => {
          s += P.STATE_COEF[stateOf(e, P.GAN_WUXING[gw[0]])] * (gw[1] / 100.0);
        });
        row[e] = Math.round(s * 1000) / 1000;
      });
      table[zhi] = row;
    });
    _coefCache[key] = table;
    return table;
  }

  // 自检：每月"本气五行"的月系数应为该月最大
  function selfCheck(useSishi) {
    const bad = [];
    const table = monthCoefTable(useSishi);
    Object.keys(P.ZHI_CANGGAN).forEach((zhi) => {
      const ben = P.GAN_WUXING[benqiGan(zhi, useSishi)];
      const row = table[zhi];
      const mx = Math.max.apply(null, WUXING_ORDER.map((e) => row[e]));
      if (row[ben] < mx - 1e-9) {
        bad.push(zhi + '月 本气' + ben + '(' + row[ben] + ') 非最大(' + mx + ')');
      }
    });
    return bad;
  }

  // 某天干相对日主的十神
  function shiShen(dayGan, gan) {
    const me = P.GAN_WUXING[dayGan], e = P.GAN_WUXING[gan];
    const same = P.GAN_YINYANG[dayGan] === P.GAN_YINYANG[gan];
    if (e === me) return same ? '比肩' : '劫财';
    if (P.SHENG[me] === e) return same ? '食神' : '伤官';
    if (P.KE[me] === e) return same ? '偏财' : '正财';
    if (P.KE[e] === me) return same ? '七杀' : '正官';
    return same ? '偏印' : '正印';
  }

  // ════════════════════════════════════════════════════════════
  //  一、分层计算（每层纯函数）
  // ════════════════════════════════════════════════════════════

  // L1 组成：天干 100 + 藏干权重（×柱位权重）→ 五行初值 init / 十神初值 shenInit
  //   monthSishi —— 月支藏干是否用司事表（渊海变体=false / 司事变体=true）
  function layerL1(pillars, monthSishi, opts) {
    opts = opts || {};
    const countDM = (opts.countDayMaster != null) ? opts.countDayMaster : P.COUNT_DAY_MASTER;
    const dayGan = pillars[2][0];
    const init = {}, shenInit = {};
    WUXING_ORDER.forEach((e) => { init[e] = 0; });
    for (let i = 0; i < 4; i++) {
      const gan = pillars[i][0], zhi = pillars[i][1];
      const pw = P.PILLAR_WEIGHT[PILLAR_NAMES[i]];
      if (!(i === 2 && !countDM)) {
        const e = P.GAN_WUXING[gan];
        init[e] += P.GAN_BASE * pw;
        const ss = shiShen(dayGan, gan);
        shenInit[ss] = (shenInit[ss] || 0) + P.GAN_BASE * pw;
      }
      cangganOf(zhi, i === 1, monthSishi).forEach((gw) => {
        const e = P.GAN_WUXING[gw[0]];
        init[e] += gw[1] * pw;
        const ss = shiShen(dayGan, gw[0]);
        shenInit[ss] = (shenInit[ss] || 0) + gw[1] * pw;
      });
    }
    return { init, shenInit };
  }

  // L2 旺衰：init × 月令系数(月支组成 = monthSishi 变体) → final / pct / shen
  function layerL2(pillars, L1, monthSishi, opts) {
    opts = opts || {};
    const countDM = (opts.countDayMaster != null) ? opts.countDayMaster : P.COUNT_DAY_MASTER;
    const dayGan = pillars[2][0];
    const monthZhi = pillars[1][1];
    const coef = monthCoefTable(monthSishi)[monthZhi];

    const final = {}, pct = {};
    let total = 0;
    WUXING_ORDER.forEach((e) => { final[e] = L1.init[e] * coef[e]; total += final[e]; });
    if (!total) total = 1;
    WUXING_ORDER.forEach((e) => { pct[e] = final[e] / total * 100; });

    // 十神力量：逐字判十神，按"五行系数"分摊
    const shen = {};
    for (let i = 0; i < 4; i++) {
      const gan = pillars[i][0], zhi = pillars[i][1];
      const pw = P.PILLAR_WEIGHT[PILLAR_NAMES[i]];
      if (!(i === 2 && !countDM)) {
        const ss = shiShen(dayGan, gan);
        shen[ss] = (shen[ss] || 0) + P.GAN_BASE * pw * coef[P.GAN_WUXING[gan]];
      }
      cangganOf(zhi, i === 1, monthSishi).forEach((gw) => {
        const ss = shiShen(dayGan, gw[0]);
        shen[ss] = (shen[ss] || 0) + gw[1] * pw * coef[P.GAN_WUXING[gw[0]]];
      });
    }
    return { coef, final, pct, total, shen };
  }

  // 给定"月支组成变体"，一次算出 L1+L2
  function computeVariant(pillars, monthSishi, opts) {
    const L1 = layerL1(pillars, monthSishi, opts);
    const L2 = layerL2(pillars, L1, monthSishi, opts);
    return { L1, L2 };
  }

  // ════════════════════════════════════════════════════════════
  //  一·五、L4 刑冲合害层
  //   · 4a 检测关系（天干五合/相冲；地支六合/三合/三会/六冲/六害/三刑/自刑/六破），
  //        含距离分级（紧贴/隔柱/遥隔）。天干-地支跨类不作用。
  //   · 4c 合化判定：六合/五合按 7 条件自动判 真化/假化/不化。
  //   · 4b 修正（仅开关）：力主要来自【冲】（双向、旺衰、四库开库）+【合化成局】加项；
  //        害/刑/破 默认只标注（系数 0）。产出本层 final/pct，浅层原值保留。
  //   · 4d 宫位维度（读象）。
  // ════════════════════════════════════════════════════════════

  const SANHE_ZHONGSHEN = ['子', '午', '卯', '酉'];

  // 克 X 的五行 / 生 X 的五行
  function keOf(x) { let r = null; WUXING_ORDER.forEach((k) => { if (P.KE[k] === x) r = k; }); return r; }
  function shengOf(x) { let r = null; WUXING_ORDER.forEach((k) => { if (P.SHENG[k] === x) r = k; }); return r; }

  function distLevel(d) { return d <= 1 ? '紧贴' : d === 2 ? '隔柱' : '遥隔'; }
  function distCoef(d) { const D = P.L4.DISTANCE; return (D[d] != null) ? D[d] : D[3]; }

  // 在 arr（长度4）中找 chars（2个）的全部落位组合
  function matchPairs(arr, chars) {
    const res = [];
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
      const s = [arr[i], arr[j]];
      if ((s[0] === chars[0] && s[1] === chars[1]) || (s[0] === chars[1] && s[1] === chars[0])) res.push([i, j]);
    }
    return res;
  }
  // 在 arr 中找 chars（3个不同）的全部落位
  function matchTriple(arr, chars) {
    const res = [], key = chars.slice().sort().join('');
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) for (let k = j + 1; k < 4; k++) {
      if ([arr[i], arr[j], arr[k]].slice().sort().join('') === key) res.push([i, j, k]);
    }
    return res;
  }

  const KIND_SYM = { '合': '合', '冲': '冲', '害': '害', '刑': '刑', '破': '破' };

  // 4a 检测：返回关系清单
  function detectRelations(pillars) {
    const gans = pillars.map((p) => p[0]), zhis = pillars.map((p) => p[1]);
    const rels = [];
    const add = (type, kind, chars, idx, huaShen, extra) => {
      const span = (idx.length > 1) ? (Math.max.apply(null, idx) - Math.min.apply(null, idx)) : 1;
      const d = Math.max(1, span);
      rels.push(Object.assign({
        type: type, kind: kind, chars: chars, idx: idx,
        dist: d, distLevel: distLevel(d), coef: distCoef(d),
        huaShen: huaShen || null, label: chars.join('') + (KIND_SYM[kind] || '')
      }, extra || {}));
    };

    // 天干：五合 / 相冲
    P.L4.GAN_HE.forEach((t) => matchPairs(gans, t.slice(0, 2)).forEach((ij) => add('天干五合', '合', t.slice(0, 2), ij, t[2])));
    P.L4.GAN_CHONG.forEach((t) => matchPairs(gans, t).forEach((ij) => add('天干相冲', '冲', t, ij)));

    // 地支：六合 / 六冲 / 六害 / 六破
    P.L4.ZHI_LIUHE.forEach((t) => matchPairs(zhis, [t[0], t[1]]).forEach((ij) => add('地支六合', '合', [t[0], t[1]], ij, t[2])));
    P.L4.ZHI_LIUCHONG.forEach((t) => matchPairs(zhis, t).forEach((ij) => add('地支六冲', '冲', t, ij)));
    P.L4.ZHI_LIUHAI.forEach((t) => matchPairs(zhis, t).forEach((ij) => add('地支六害', '害', t, ij)));
    P.L4.ZHI_LIUPO.forEach((t) => matchPairs(zhis, t).forEach((ij) => add('地支六破', '破', t, ij)));

    // 地支：三合（成局）/ 半合 / 拱
    P.L4.ZHI_SANHE.forEach((t) => {
      const set = [t[0], t[1], t[2]], hua = t[3];
      const zs = set.find((c) => SANHE_ZHONGSHEN.indexOf(c) >= 0);
      const full = matchTriple(zhis, set);
      full.forEach((ijk) => add('三合局', '合', set, ijk, hua, { ju: '成局', zhong: zs }));
      if (!full.length) {
        for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
          const pair = [set[a], set[b]], hasZ = pair.indexOf(zs) >= 0;
          matchPairs(zhis, pair).forEach((ij) => add(hasZ ? '半合' : '三合拱', '合', pair, ij, hua, { ju: hasZ ? '半合' : '拱', zhong: zs }));
        }
      }
    });

    // 地支：三会（成会）/ 半会 / 拱会
    P.L4.ZHI_SANHUI.forEach((t) => {
      const set = [t[0], t[1], t[2]], hua = t[3], zs = set[1]; // 三会=[生,旺,墓]，中神＝旺
      const full = matchTriple(zhis, set);
      full.forEach((ijk) => add('三会局', '合', set, ijk, hua, { ju: '成会', zhong: zs }));
      if (!full.length) {
        for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
          const pair = [set[a], set[b]], hasZ = pair.indexOf(zs) >= 0;
          matchPairs(zhis, pair).forEach((ij) => add(hasZ ? '半会' : '三会拱', '合', pair, ij, hua, { ju: hasZ ? '半会' : '拱', zhong: zs }));
        }
      }
    });

    // 地支：三刑 / 相刑 / 子卯刑 / 自刑
    P.L4.ZHI_SANXING.forEach((t) => {
      const full = matchTriple(zhis, t);
      full.forEach((ijk) => add('三刑', '刑', t, ijk));
      if (!full.length) {
        for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
          matchPairs(zhis, [t[a], t[b]]).forEach((ij) => add('相刑', '刑', [t[a], t[b]], ij));
        }
      }
    });
    P.L4.ZHI_XING2.forEach((t) => matchPairs(zhis, t).forEach((ij) => add('子卯刑', '刑', t, ij)));
    P.L4.ZHI_ZIXING.forEach((c) => {
      const pos = []; for (let i = 0; i < 4; i++) if (zhis[i] === c) pos.push(i);
      for (let a = 0; a < pos.length; a++) for (let b = a + 1; b < pos.length; b++) add('自刑', '刑', [c, c], [pos[a], pos[b]]);
    });

    return rels;
  }

  // 4c 合化判定：六合/五合 按 7 条件（阈值皆相对量）
  function judgeHua(rel, baseVals) {
    if (!rel.huaShen) return null;
    const R = P.L4.RULE, hua = rel.huaShen, fails = [];
    const A = !R.needMonth || (baseVals.coef[hua] >= R.monthMin);              // 得月令
    const B = ((baseVals.pct[hua] || 0) / 100) >= R.huaShare;                  // 化神有力
    const ke = keOf(hua);
    const C = ((baseVals.pct[ke] || 0) / 100) <= R.keShareMax;                 // 无强克神
    const D = !R.needAdjacent || rel.dist === 1 || rel.type.indexOf('三') >= 0 || rel.type.indexOf('半') >= 0; // 紧邻
    const E = !R.noZheng || !rel.zheng;                                        // 无争合/妒合
    const F = !R.noChong || !rel.touchedByChong;                              // 无冲破
    if (!A) fails.push('未得月令');
    if (!B) fails.push('化神弱');
    if (!C) fails.push('克神强');
    if (!D) fails.push('不紧邻');
    if (!E) fails.push('争/妒合');
    if (!F) fails.push('逢冲破');
    let hua2;
    if (A && B && C && D && E && F) hua2 = '真化';
    else if (B && D && E && F) hua2 = '假化';
    else hua2 = '不化';
    return { hua: hua2, fails: fails };
  }

  // 十神 → 五行（给定时日主）
  function shiShenElement(dayGan, name) {
    const me = P.GAN_WUXING[dayGan];
    if (name === '比肩' || name === '劫财') return me;
    if (name === '食神' || name === '伤官') return P.SHENG[me];
    if (name === '偏财' || name === '正财') return P.KE[me];
    if (name === '七杀' || name === '正官') return keOf(me);
    return shengOf(me); // 偏印/正印 = 生日主
  }

  // L4 十神：按"所在五行的新旧比"整体缩放（add 亦按原比例分摊）
  function scaleShen(dayGan, baseVals, final4) {
    const out = {}; const ratio = {};
    WUXING_ORDER.forEach((e) => {
      const bf = baseVals.final[e];
      ratio[e] = bf > 0 ? (final4[e] / bf) : 1;
    });
    Object.keys(baseVals.shen).forEach((k) => {
      const e = shiShenElement(dayGan, k);
      out[k] = baseVals.shen[k] * (e ? (ratio[e] || 1) : 1);
    });
    return out;
  }

  // 4b+4d 主入口
  function layerL4(pillars, baseName, baseVals, opts) {
    opts = opts || {};
    const apply = !!opts.l4Apply;
    const gans = pillars.map((p) => p[0]), zhis = pillars.map((p) => p[1]);
    const rels = detectRelations(pillars);

    // 标注：争合 / 逢冲破 / 宫位
    const chongIdx = {};
    rels.filter((r) => r.type === '地支六冲').forEach((r) => r.idx.forEach((i) => { chongIdx[i] = true; }));
    const cnt = (arr, c) => arr.filter((x) => x === c).length;
    rels.forEach((r) => {
      if (r.kind === '合' && r.chars[0] !== r.chars[1]) {
        const arr = (r.type.indexOf('天干') >= 0) ? gans : zhis;
        r.zheng = cnt(arr, r.chars[0]) > 1 || cnt(arr, r.chars[1]) > 1;
      } else r.zheng = false;
      r.touchedByChong = (r.kind === '合' && r.type.indexOf('天干') < 0) ? r.idx.some((i) => chongIdx[i]) : false;
      r.gongwei = r.idx.map((i) => PILLAR_NAMES[i] + '柱');
    });

    // 合化判定 + 成局分档
    const harmony = { '真化': [], '假化': [], '不化': [], '成局': [], '半合': [] };
    rels.forEach((r) => {
      if (r.type === '天干五合' || r.type === '地支六合') {
        r.hua = judgeHua(r, baseVals);
        if (r.hua) harmony[r.hua.hua].push(r);
      } else if (r.ju) {
        const bucket = (r.ju === '半合' || r.ju === '拱' || r.ju === '半会') ? '半合' : '成局';
        r.juBucket = bucket; harmony[bucket].push(r);
      }
    });

    // 宫位维度（读象）
    const gongwei = PILLAR_NAMES.map((nm, i) => Object.assign(
      { pillar: nm, char: String(pillars[i][0]) + String(pillars[i][1]) }, P.L4.GONGWEI[nm]));

    // ── 4b 修正（仅当开关）──
    let factor = null, addv = null, final = null, pct = null, total = null, shen = null;
    if (apply) {
      factor = {}; addv = {};
      WUXING_ORDER.forEach((e) => { factor[e] = 1; addv[e] = 0; });
      const monthWx = P.GAN_WUXING[benqiGan(pillars[1][1], opts.useSishi)];

      // 冲（双向）
      rels.filter((r) => r.type === '地支六冲').forEach((r) => {
        const ci = r.idx[0], cj = r.idx[1], lvl = r.coef;
        const Ei = P.GAN_WUXING[P.ZHI_CANGGAN[zhis[ci]][0][0]];
        const Ej = P.GAN_WUXING[P.ZHI_CANGGAN[zhis[cj]][0][0]];
        if (Ei === Ej) { // 四库土冲：土增、库神显用、杂气受伤
          factor[Ei] *= (1 + P.L4.KUPO.tu * lvl);
          [zhis[ci], zhis[cj]].forEach((z) => {
            const cg = P.ZHI_CANGGAN[z];
            factor[P.GAN_WUXING[cg[cg.length - 1][0]]] *= (1 + P.L4.KUPO.kushen * lvl); // 库神=余气
            cg.forEach((g, gi) => { if (gi !== 0 && gi !== cg.length - 1) factor[P.GAN_WUXING[g[0]]] *= (1 + P.L4.KUPO.zaqi * lvl); });
          });
        } else {
          const main = (P.KE[Ei] === Ej) ? ci : cj; // 主冲方＝克对方者
          [[ci, Ei], [cj, Ej]].forEach((s) => {
            const idx = s[0], E = s[1];
            const st = stateOf(E, monthWx);
            let k = 1;
            if (st === '旺' || st === '相') k = P.L4.CHONG.qiang;
            else if (st === '囚' || st === '死') k = P.L4.CHONG.ruo;
            const loss = P.L4.CHONG.base * lvl * ((idx === main) ? P.L4.CHONG.zhu : 1) * k;
            factor[E] *= Math.max(0, 1 - loss);
          });
        }
      });

      // 合化成局 加项（相对量：以基准五行总和为 1）
      const baseTotal = baseVals.total || 1;
      rels.forEach((r) => {
        if (r.type === '天干五合' || r.type === '地支六合') {
          if (r.hua && r.hua.hua === '真化') addv[r.huaShen] += baseTotal * P.L4.HEHUA.zhen;
          else if (r.hua && r.hua.hua === '假化') addv[r.huaShen] += baseTotal * P.L4.HEHUA.jia;
        } else if (r.ju) {
          addv[r.huaShen] += baseTotal * ((r.juBucket === '半合') ? P.L4.HEHUA.ban : P.L4.HEHUA.ju);
        }
      });

      // 害/刑/破 微调（默认 0 → 不改值）
      rels.forEach((r) => {
        const c0 = (r.kind === '害') ? P.L4.EFF.hai : (r.kind === '刑') ? P.L4.EFF.xing : (r.kind === '破') ? P.L4.EFF.po : 0;
        const c = c0 * r.coef;
        if (c) r.idx.forEach((i) => { factor[P.GAN_WUXING[P.ZHI_CANGGAN[zhis[i]][0][0]]] *= (1 - c); });
      });

      final = {}; let tot = 0;
      WUXING_ORDER.forEach((e) => { final[e] = Math.max(0, baseVals.final[e] * factor[e] + addv[e]); tot += final[e]; });
      if (!tot) tot = 1;
      pct = {}; WUXING_ORDER.forEach((e) => { pct[e] = final[e] / tot * 100; });
      total = tot;
      shen = scaleShen(pillars[2][0], baseVals, final);
    }

    return {
      base: baseName, apply: apply,
      relations: rels, harmony: harmony, gongwei: gongwei,
      coef: baseVals.coef, factor: factor, add: addv,
      final: final, pct: pct, total: total, shen: shen
    };
  }

  // ════════════════════════════════════════════════════════════
  //  一·六、L5 流通层（相生环 + 断链 / 通关）
  //   从最深值层取数（baseVals.final）；产出本层：各生边流量、断链、克线通关/相战、流通分。
  //   ★不改任何浅层的五行/十神值★
  //   · 生边（外圈，5 条）：F=min(N母,N子)（受最弱环限制）。节点 N<T×BREAK_SHARE 记为弱节点，
  //       生边一端弱 → 判"断"（灰虚线），否则"通"。
  //   · 克线（内五角，5 条）：克对(A克B)，中神 C=SHENG[A]（且 SHENG[C]===B）。N_C<T×TONGGUAN_SHARE
  //       → "相战"（红）；否则"通关"（木之气经 C 转生 B，克被化解）。
  //   · 流通分 score=通畅生边数/5×100。
  // ════════════════════════════════════════════════════════════
  function layerL5(pillars, baseName, baseVals, opts) {
    opts = opts || {};
    const cfg = P.L5;
    const base = cfg.BASE || 'auto';

    const N = {}, T = baseVals.total || 1;
    WUXING_ORDER.forEach((e) => { N[e] = baseVals.final[e]; });

    // 生边（沿 WUXING_RING：母→子）
    const sheng = [];
    const weak = {}; // 弱节点
    WUXING_ORDER.forEach((e) => { weak[e] = N[e] < cfg.BREAK_SHARE * T; });
    WUXING_RING.forEach((e, i) => {
      const to = WUXING_RING[(i + 1) % 5];
      const flow = (cfg.FLOW === 'geom') ? Math.sqrt(N[e] * to) : Math.min(N[e], N[to]);
      const state = (weak[e] || weak[to]) ? '断' : '通';
      sheng.push({ from: e, to: to, flow: flow, state: state });
    });

    // 克线（内五角：i→(i+2)%5 = A克B）
    const ke = [];
    WUXING_RING.forEach((e, i) => {
      const to = WUXING_RING[(i + 2) % 5];   // e 克 to
      const via = P.SHENG[e];                // 中神（且 SHENG[via]===to）
      const through = N[via] >= cfg.TONGGUAN_SHARE * T;
      ke.push({ from: e, to: to, via: via, through: through, state: through ? '通关' : '相战' });
    });

    const broken = sheng.filter((s) => s.state === '断');
    const tongguan = ke.filter((k) => k.through);
    const xiangzhan = ke.filter((k) => !k.through);
    const tongCount = sheng.filter((s) => s.state === '通').length;
    const score = Math.round(tongCount / 5 * 100);

    const nodes = {};
    WUXING_ORDER.forEach((e) => { nodes[e] = { val: N[e], pct: T ? N[e] / T * 100 : 0, weak: weak[e] }; });

    return {
      base: baseName, baseFrom: base,
      nodes: nodes, total: T,
      sheng: sheng, ke: ke,
      broken: broken, tongguan: tongguan, xiangzhan: xiangzhan,
      tongCount: tongCount, tongguanCount: tongguan.length,
      score: score
    };
  }

  // ── 管线：L0 → L1 → L2 → (L3) → L4 → L5 ──
  //   opts.useSishi —— 是否产出 L3 司令层（默认取 P.USE_SISHI）
  //   opts.l4Apply  —— 是否让 L4 参与数值修正（默认取 P.L4.L4_APPLY）；否则 L4 只标注
  //   opts.upto     —— 只跑到某层（'L1'|'L2'|'L3'|'L4'|'L5'），实现"每层可单独运行"
  function run(pillars, opts) {
    opts = opts || {};
    const useSishi = (opts.useSishi != null) ? opts.useSishi : P.USE_SISHI;
    const upto = opts.upto || 'L5';

    const st = {
      L0: { pillars: pillars, dayGan: pillars[2][0], monthZhi: pillars[1][1], useSishi: useSishi }
    };

    // 渊海变体 = L1 / L2
    const vBase = computeVariant(pillars, false, opts);
    st.L1 = vBase.L1;
    if (upto === 'L1') return st;

    st.L2 = vBase.L2;
    if (upto === 'L2') return st;

    // 司令变体 = L3（月支改用司事表；其余三支仍渊海）
    if (useSishi) {
      const vS = computeVariant(pillars, true, opts);
      st.L3 = {
        init: vS.L1.init, shenInit: vS.L1.shenInit,
        coef: vS.L2.coef, final: vS.L2.final, pct: vS.L2.pct,
        total: vS.L2.total, shen: vS.L2.shen
      };
    }
    if (upto === 'L3') return st;

    // L4 刑冲合害：从最深可用层取数（有 L3 用 L3，否则 L2）
    const baseName = st.L3 ? 'L3' : 'L2';
    const l4Apply = (opts.l4Apply != null) ? opts.l4Apply : P.L4.L4_APPLY;
    st.L4 = layerL4(pillars, baseName, st[baseName], { l4Apply: l4Apply, useSishi: useSishi });
    if (upto === 'L4') return st;

    // L5 流通：从最深"值层"取数（L4 修正→L4；否则 L3||L2）。BASE 可强制指定。
    let l5Base = activeLayerName(st);
    if (P.L5.BASE && P.L5.BASE !== 'auto' && st[P.L5.BASE] && st[P.L5.BASE].final) l5Base = P.L5.BASE;
    st.L5 = layerL5(pillars, l5Base, st[l5Base], opts);
    return st;
  }

  // 最深启用层名（L4 参与修正则 L4；否则 L3 存在则 L3，否则 L2）
  function activeLayerName(st) {
    if (st.L4 && st.L4.apply) return 'L4';
    return st.L3 ? 'L3' : 'L2';
  }

  // 兼容壳：旧调用 Bazi.analyze(pillars,{useSishi})，返回最深启用层的值 + L1 明细
  function analyze(pillars, opts) {
    const st = run(pillars, opts || {});
    const name = activeLayerName(st);
    const act = st[name];
    return {
      pillars: pillars, dayGan: st.L0.dayGan, monthZhi: st.L0.monthZhi,
      coef: act.coef, init: st.L1.init, final: act.final, pct: act.pct,
      total: act.total, shen: act.shen, useSishi: st.L0.useSishi,
      layer: name, state: st
    };
  }

  // ════════════════════════════════════════════════════════════
  //  二、排盘（万年历 → 四柱）+ 司令
  // ════════════════════════════════════════════════════════════

  // 节(十二节) → 所主月支
  const JIE_TO_ZHI = {
    '立春': '寅', '惊蛰': '卯', '清明': '辰', '立夏': '巳',
    '芒种': '午', '小暑': '未', '立秋': '申', '白露': '酉',
    '寒露': '戌', '立冬': '亥', '大雪': '子', '小寒': '丑'
  };

  // 距本节 days 天 → 当令干(司令)
  function silingOf(monthZhi, days) {
    let cum = 0;
    const lst = P.SISHI[monthZhi];
    for (let i = 0; i < lst.length; i++) {
      cum += lst[i][1];
      if (days < cum) return lst[i][0];
    }
    return lst[lst.length - 1][0];
  }

  // 阳历时间 → 四柱。lon 为东经度数（真太阳时经度校正）。sect：1/2 子时换日流派。
  function paipan(y, mo, d, hh, mi, sect, lon) {
    const Solar = SolarLib.Solar;
    sect = sect || 2;
    let note = '';
    if (lon != null) {
      const deltaMin = (lon - 120.0) * 4.0;
      const base = new Date(y, mo - 1, d, hh, mi);
      const adj = new Date(base.getTime() + deltaMin * 60000);
      y = adj.getFullYear(); mo = adj.getMonth() + 1; d = adj.getDate();
      hh = adj.getHours(); mi = adj.getMinutes();
      note = '真太阳时校正 ' + (deltaMin >= 0 ? '+' : '') + deltaMin.toFixed(1) + ' 分钟（仅经度差，未含均时差）';
    }
    const solar = Solar.fromYmdHms(y, mo, d, hh, mi, 0);
    const lunar = solar.getLunar();
    const ba = lunar.getEightChar();
    ba.setSect(sect);
    const pillars = [
      [ba.getYearGan(), ba.getYearZhi()],
      [ba.getMonthGan(), ba.getMonthZhi()],
      [ba.getDayGan(), ba.getDayZhi()],
      [ba.getTimeGan(), ba.getTimeZhi()]
    ];
    // 司令：距本节(立春/惊蛰…)的天数 → 当月当令之人元
    const jie = lunar.getPrevJie();
    const js = jie.getSolar();
    const jieDate = new Date(js.getYear(), js.getMonth() - 1, js.getDay(),
      js.getHour(), js.getMinute(), js.getSecond ? js.getSecond() : 0);
    const birthDate = new Date(y, mo - 1, d, hh, mi);
    const days = (birthDate.getTime() - jieDate.getTime()) / 86400000;
    const siling = { gan: silingOf(pillars[1][1], days), jie: jie.getName(), days: days };
    return { pillars: pillars, lunarStr: String(lunar), note: note, siling: siling };
  }

  const Bazi = {
    P: P,
    WUXING_ORDER: WUXING_ORDER,
    WUXING_RING: WUXING_RING,
    // 基础工具
    stateOf: stateOf,
    cangganOf: cangganOf,
    benqiGan: benqiGan,
    monthCoefTable: monthCoefTable,
    selfCheck: selfCheck,
    shiShen: shiShen,
    // 分层
    LAYERS: ['L1', 'L2', 'L3', 'L4', 'L5'],
    layer: { L1: layerL1, L2: layerL2, L4: layerL4, L5: layerL5 },
    run: run,
    activeLayerName: activeLayerName,
    analyze: analyze,
    // 排盘
    JIE_TO_ZHI: JIE_TO_ZHI,
    silingOf: silingOf,
    paipan: paipan
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Bazi;
  else globalThis.Bazi = Bazi;
})();
