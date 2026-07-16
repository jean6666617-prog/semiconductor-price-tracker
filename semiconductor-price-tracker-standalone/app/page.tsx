"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { categorySources, seedItems } from "./data";
import { workbookHistory, workbookItems } from "./workbook-data";
import type { Item, Status } from "./types";

const retainedGroups = new Set(["SOC芯片", "MCU芯片", "PCB", "SGT MOS / MOSFET"]);
const seed: Item[] = [...seedItems.filter((item) => retainedGroups.has(item.group)), ...workbookItems] as Item[];

const statuses: Status[] = ["已更新", "待更新", "待确认", "暂无来源"];

const legacyPlasticHistory: Record<string, [string, number][]> = {
  ABS: [["07-04",8650],["07-05",8650],["07-06",8683.33],["07-07",8783.33],["07-08",9050],["07-09",9316.67],["07-10",9450],["07-11",9450],["07-12",9450],["07-13",9483.33],["07-14",9483.33],["07-15",9916.67]],
  PVC: [["07-04",4355],["07-05",4355],["07-06",4425],["07-07",4389],["07-08",4413],["07-09",4435],["07-10",4435],["07-11",4435],["07-12",4435],["07-13",4440],["07-14",4469],["07-15",4475]],
  PC: [["07-04",12700],["07-05",12700],["07-06",12566.67],["07-07",12700],["07-08",12566.67],["07-09",12566.67],["07-10",12850],["07-11",12850],["07-12",12850],["07-13",12933.33],["07-14",12933.33],["07-15",13033.33]],
  PET: [["07-03",6932.5],["07-04",6985],["07-05",6985],["07-06",7000],["07-07",7035],["07-08",7192.5],["07-09",7192.5],["07-10",7225],["07-11",7225],["07-12",7225],["07-13",7225],["07-14",7285]],
  PP: [["07-09",8566.67],["07-10",8633.33],["07-11",8633.33],["07-12",8633.33],["07-13",8850],["07-14",8850],["07-15",9093.33]],
};

const initialHistory: Record<string, [string, number][]> = { ...workbookHistory };
for (const item of seed.filter((entry) => retainedGroups.has(entry.group))) {
  const value = Number(String(item.price).replace(/[^0-9.-]/g, ""));
  if (Number.isFinite(value) && item.updated) initialHistory[`${item.group}::${item.name}`] = [[item.updated, value]];
}

function normalize(value: unknown) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
}

function dateKey(value: unknown) {
  const date = value instanceof Date ? value : typeof value === "number"
    ? new Date(Math.round((value - 25569) * 86400 * 1000))
    : new Date(String(value));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

export default function Home() {
  const [items, setItems] = useState<Item[]>(seed);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("全部品类");
  const [status, setStatus] = useState("全部状态");
  const [trendGroup, setTrendGroup] = useState("塑料件");
  const [trendCommodity, setTrendCommodity] = useState("塑料件::ABS");
  const [history, setHistory] = useState<Record<string, [string, number][]>>(initialHistory);
  const [importedLatestDate, setImportedLatestDate] = useState("");
  const [importMessage, setImportMessage] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState({ source: "", url: "" });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("semiconductor-price-items-v8");
    if (saved) {
      try { setItems(JSON.parse(saved)); } catch { /* keep defaults */ }
    }
    const savedHistory = localStorage.getItem("semiconductor-price-history-v5");
    if (savedHistory) {
      try { setHistory(JSON.parse(savedHistory)); } catch { /* keep defaults */ }
    }
    setImportedLatestDate(localStorage.getItem("semiconductor-price-latest-date-v3") || "");
    setReady(true);
  }, []);

  useEffect(() => {
    if (ready) localStorage.setItem("semiconductor-price-items-v8", JSON.stringify(items));
  }, [items, ready]);

  useEffect(() => {
    if (ready) localStorage.setItem("semiconductor-price-history-v5", JSON.stringify(history));
  }, [history, ready]);

  useEffect(() => {
    if (ready && importedLatestDate) localStorage.setItem("semiconductor-price-latest-date-v3", importedLatestDate);
  }, [importedLatestDate, ready]);

  const groups = useMemo(() => ["全部品类", ...Array.from(new Set(items.map((item) => item.group)))], [items]);
  const visible = useMemo(() => items.filter((item) => {
    const hit = `${item.group}${item.name}${item.spec}${item.source}${item.supplier}${item.mpn}`.toLowerCase().includes(query.toLowerCase());
    return hit && (group === "全部品类" || item.group === group) && (status === "全部状态" || item.status === status);
  }), [items, query, group, status]);

  const updated = items.filter((item) => item.status === "已更新").length;
  const sourced = items.filter((item) => item.url).length;
  const rate = Math.round((updated / items.length) * 100);
  const latestItemDate = items.reduce((latest, item) => item.updated > latest ? item.updated : latest, "");
  const latestDate = importedLatestDate > latestItemDate ? importedLatestDate : latestItemDate;
  const [latestYear, latestMonth, latestDay] = latestDate.split("-");
  const trendGroups = Array.from(new Set(Object.keys(history).map((key) => key.split("::")[0])));
  const trendOptions = Object.keys(history).filter((key) => key.startsWith(`${trendGroup}::`));
  const activeTrendKey = trendOptions.includes(trendCommodity) ? trendCommodity : trendOptions[0] || Object.keys(history)[0];
  const trendName = activeTrendKey?.split("::").slice(1).join("::") || "暂无数据";
  const trend = history[activeTrendKey] ?? [["—", 0]];
  const trendPrices = trend.map((point) => point[1]);
  const trendMin = Math.min(...trendPrices);
  const trendMax = Math.max(...trendPrices);
  const trendRange = Math.max(trendMax - trendMin, 1);
  const chartPoints = trend.map((point, index) => `${8 + index * (84 / Math.max(trend.length - 1, 1))},${82 - ((point[1] - trendMin) / trendRange) * 64}`).join(" ");
  const dailyChange = (trendPrices.at(-1)! - trendPrices[0]) / Math.max(trendPrices.length - 1, 1);
  const forecast = trendPrices.at(-1)! + dailyChange;
  const changeRate = ((trendPrices.at(-1)! / trendPrices[0]) - 1) * 100;

  function markUpdated(id: number) {
    const today = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date()).replaceAll("/", "-");
    setItems((current) => current.map((item) => item.id === id ? { ...item, status: "已更新", updated: today } : item));
  }

  function openEditor(item: Item) {
    setEditing(item.id);
    setDraft({ source: item.source, url: item.url });
  }

  function saveReference() {
    setItems((current) => current.map((item) => item.id === editing
      ? { ...item, source: draft.source || "参考来源（占位）", url: draft.url, status: draft.url ? item.status === "暂无来源" ? "待确认" : item.status : "暂无来源" }
      : item));
    setEditing(null);
  }

  function resetData() {
    setItems(seed);
    setHistory(initialHistory);
    setImportedLatestDate("");
    localStorage.removeItem("semiconductor-price-latest-date-v3");
    setImportMessage("");
    setQuery(""); setGroup("全部品类"); setStatus("全部状态");
  }

  async function importExcel(file?: File) {
    if (!file) return;
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
      const findSheet = (expected: string) => {
        const target = normalize(expected);
        const name = workbook.SheetNames.find((candidate) => normalize(candidate) === target)
          || workbook.SheetNames.find((candidate) => normalize(candidate).includes(target) || target.includes(normalize(candidate)));
        return name ? workbook.Sheets[name] : undefined;
      };
      const rows = (sheet: string) => {
        const worksheet = findSheet(sheet);
        return worksheet ? XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: "" }) : [];
      };
      const totals = rows("总表");
      const market = rows("DDR-BATTERY-LCD");
      const plastics = rows("塑料件");
      if (!totals.length && !market.length && !plastics.length) throw new Error("未找到约定工作表");

      const allRows = [...totals, ...market, ...plastics];
      const recognizedDates = allRows.map((row) => dateKey(row.Date || row["日期"] || row["数据日期"])).filter(Boolean).sort();
      const workbookLatest = recognizedDates.at(-1) || "";
      if (workbookLatest) setImportedLatestDate(workbookLatest);

      const importedHistory: Record<string, [string, number][]> = {};
      const marketGroupName: Record<string, string> = { ddr: "DDR内存", lcd: "LCD屏幕", battery: "电池", nandflash: "NAND Flash" };
      market.forEach((row) => {
        const groupName = marketGroupName[normalize(row.Category)] || String(row.Category || "").trim();
        const name = String(row.Item || "").trim();
        const price = Number(row["Session Average"]);
        const date = dateKey(row.Date);
        if (groupName && name && date && Number.isFinite(price)) (importedHistory[`${groupName}::${name}`] ||= []).push([date, price]);
      });
      plastics.forEach((row) => {
        const name = String(row.Commodity || "").trim();
        const price = Number(row.Price);
        const date = dateKey(row.Date);
        if (name && date && Number.isFinite(price)) (importedHistory[`塑料件::${name}`] ||= []).push([date, price]);
      });
      totals.forEach((row) => {
        const groupName = String(row.Category || "").trim();
        const name = String(row.Material_Name || "").trim();
        const price = Number(String(row["Latest Price"] || row["Session Average"]).replace(/[^0-9.-]/g, ""));
        const date = dateKey(row.Date);
        if (retainedGroups.has(groupName) && name && date && Number.isFinite(price)) (importedHistory[`${groupName}::${name}`] ||= []).push([date, price]);
      });
      Object.values(importedHistory).forEach((series) => series.sort((a, b) => a[0].localeCompare(b[0])));
      if (Object.keys(importedHistory).length) {
        setHistory(importedHistory);
        if (!importedHistory[activeTrendKey]) {
          const first = Object.keys(importedHistory)[0];
          setTrendGroup(first.split("::")[0]);
          setTrendCommodity(first);
        }
      }

      const latestPlastic = new Map<string, Record<string, unknown>>();
      plastics.forEach((row) => {
        const name = String(row.Commodity || "").trim();
        const previous = latestPlastic.get(name);
        if (!previous || dateKey(row.Date) > dateKey(previous.Date)) latestPlastic.set(name, row);
      });

      const latestMarket = new Map<string, Record<string, unknown>>();
      market.forEach((row) => {
        const key = `${normalize(row.Category)}|${normalize(row.Item)}`;
        const previous = latestMarket.get(key);
        if (key !== "|" && (!previous || dateKey(row.Date) > dateKey(previous.Date))) latestMarket.set(key, row);
      });

      let matched = 0;
      let changed = 0;
      const retainedItems = items.filter((item) => retainedGroups.has(item.group)).map((item) => {
        let row: Record<string, unknown> | undefined;
        row = totals.find((r) => normalize(r.Material_Name) === normalize(item.name));
        if (!row) return item;
        matched += 1;
        const rawPrice = row["Session Average"] || row.Price || row["Latest Price"];
        const importedDate = dateKey(row.Date || row["日期"] || row["数据日期"]) || item.updated;
        const importedUrl = String(row.Price_Source_URL || "").trim();
        const next = { ...item, price: rawPrice === "" ? item.price : String(rawPrice), updated: importedDate, url: importedUrl || item.url, status: rawPrice === "" ? item.status : "已更新" as Status };
        if (next.price !== item.price || next.updated !== item.updated || next.url !== item.url) changed += 1;
        return next;
      });
      const priorByKey = new Map(items.map((item) => [`${item.group}::${item.name}`, item]));
      const importedItems: Item[] = [];
      const addImported = (groupName: string, name: string, row: Record<string, unknown>, source: string, url: string, unit: string) => {
        const prior = priorByKey.get(`${groupName}::${name}`);
        const rawPrice = row["Session Average"] || row.Price || "";
        importedItems.push({ id: prior?.id ?? 10000 + importedItems.length, group: groupName, name, spec: name,
          supplier: String(row.Brand || "—"), mpn: "—", price: rawPrice === "" ? "—" : String(rawPrice), unit, source, url,
          status: rawPrice === "" ? "待更新" : "已更新", updated: dateKey(row.Date), cadence: groupName === "塑料件" ? "每日" : "每周" });
      };
      latestMarket.forEach((row) => {
        const groupName = marketGroupName[normalize(row.Category)] || String(row.Category || "").trim();
        addImported(groupName, String(row.Item || "").trim(), row, "TrendForce", "https://www.trendforce.com/", String(row.Unit || "—"));
      });
      const plasticUrls: Record<string, string> = { ABS: "https://www.sunsirs.com/uk/prodetail-713.html", PVC: "https://www.sunsirs.com/uk/prodetail-107.html", PC: "https://www.sunsirs.com/uk/prodetail-172.html", PET: "https://www.sunsirs.com/uk/prodetail-173.html", PP: "https://www.sunsirs.com/uk/prodetail-718.html" };
      latestPlastic.forEach((row, name) => addImported("塑料件", name, row, "生意社 Sunsirs", plasticUrls[name] || "", "RMB/吨"));
      const nextItems = [...retainedItems, ...importedItems];
      setItems(nextItems);
      const dateText = workbookLatest ? `，最晚日期 ${workbookLatest}` : "，未识别到有效日期";
      setImportMessage(`已读取 ${file.name}${dateText}；匹配 ${matched} 条，实际变化 ${changed} 条`);
    } catch {
      setImportMessage("导入失败：请确认文件包含“总表”“DDR-BATTERY-LCD”或“塑料件”工作表");
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <main>
      <header className="topbar">
        <div className="brand"><span className="brand-mark">Si</span><span>半导体价格趋势追踪中心</span></div>
        <div className="header-actions">
          <span className="offline-pill"><span className="pulse" /> 本地维护模式</span>
          <input ref={fileInput} className="file-input" type="file" accept=".xlsx,.xls" onChange={(event) => importExcel(event.target.files?.[0])} />
          <button className="import-button" onClick={() => fileInput.current?.click()}>↑ 导入 Excel</button>
          <button className="ghost-button" onClick={resetData}>恢复示例数据</button>
        </div>
      </header>

      {importMessage && <div className="import-toast" role="status">{importMessage}</div>}

      <div className="shell">
        <section className="hero">
          <div>
            <p className="eyebrow">SEMICONDUCTOR PRICE INTELLIGENCE</p>
            <h1>看见价格变化，<br /><em>判断下一步趋势。</em></h1>
            <p className="hero-copy">持续沉淀历史价格、识别涨跌方向，并为后续采购判断提供短期趋势参考。数据来源、更新状态与参考链接作为趋势分析的基础留痕。</p>
          </div>
          <div className="progress-panel">
            <div className="progress-head"><span>历史趋势覆盖</span><strong>5</strong></div>
            <div className="progress-track"><span style={{ width: `${rate}%` }} /></div>
            <div className="progress-meta"><span>塑料原料已形成连续序列</span><span>其他品类持续累计中</span></div>
          </div>
        </section>

        <section className="trend-section">
          <div className="section-heading"><div><p className="kicker">PRICE TREND & OUTLOOK</p><h2>历史价格趋势与短期参考</h2></div><p>实线为表格中的真实历史价格；右侧预测值按样本期平均日变化外推，仅用于方向参考。</p></div>
          <div className="trend-layout">
            <div className="trend-chart-card">
              <div className="trend-toolbar">
                <div className="trend-selectors">
                  <select value={trendGroup} onChange={(event) => { const nextGroup = event.target.value; const first = Object.keys(history).find((key) => key.startsWith(`${nextGroup}::`)); setTrendGroup(nextGroup); if (first) setTrendCommodity(first); }} aria-label="选择大品类">
                    {trendGroups.map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                  <select value={activeTrendKey} onChange={(event) => setTrendCommodity(event.target.value)} aria-label="选择具体物料">
                    {trendOptions.map((key) => <option key={key} value={key}>{key.split("::").slice(1).join("::")}</option>)}
                  </select>
                </div>
                <span>{trend.length} 个历史日期</span>
              </div>
              <svg className="trend-chart" viewBox="0 0 100 100" role="img" aria-label={`${trendName} 历史价格趋势`} preserveAspectRatio="none">
                {[18,34,50,66,82].map((y) => <line key={y} x1="8" y1={y} x2="92" y2={y} className="grid-line" />)}
                <polyline points={chartPoints} className="trend-line" />
                {trend.map((point, index) => <circle key={`${point[0]}-${index}`} cx={8 + index * (84 / Math.max(trend.length - 1, 1))} cy={82 - ((point[1] - trendMin) / trendRange) * 64} r="1.25" className="trend-point"><title>{point[0]}：{point[1].toLocaleString()}</title></circle>)}
              </svg>
              <div className="axis-labels"><span>{trend[0][0]}</span><span>{trend.at(-1)![0]}</span></div>
            </div>
            <aside className="trend-insight">
              <span className={`direction ${changeRate >= 0 ? "up" : "down"}`}>{changeRate >= 0 ? "↗ 上行" : "↘ 下行"}</span>
              <p>样本期变化</p><strong>{changeRate >= 0 ? "+" : ""}{changeRate.toFixed(2)}%</strong>
              <dl><div><dt>最新价格</dt><dd>{trendPrices.at(-1)!.toLocaleString()}</dd></div><div><dt>短期参考值</dt><dd>{forecast.toFixed(2)}</dd></div><div><dt>历史样本</dt><dd>{trend.length} 天</dd></div></dl>
              <small>{trend.length > 1 ? "预测值为简单线性外推；历史继续积累后可升级为移动平均或时间序列模型。" : "当前只有一个历史日期，先展示价格点；导入下一期数据后会自动形成趋势线。"}</small>
            </aside>
          </div>
          <div className="coverage-note"><strong>趋势数据状态</strong><span>所有品类均保留 Excel 中的全部日期</span><span>多期数据绘制趋势线；单期数据先显示价格点，后续导入自动延长</span></div>
        </section>

        <section className="stats" aria-label="数据总览">
          <div><span>追踪物料</span><strong>{items.length}</strong><small>覆盖 {groups.length - 1} 个品类</small></div>
          <div><span>本期已更新</span><strong className="green">{updated}</strong><small>{items.length - updated} 项仍需处理</small></div>
          <div><span>已填写链接</span><strong>{sourced}</strong><small>{items.length - sourced} 个链接待补充</small></div>
          <div><span>最新更新日期</span><strong className="date">{latestMonth} · {latestDay}</strong><small>{latestYear} 年</small></div>
        </section>

        <section className="source-section">
          <div className="section-heading"><div><p className="kicker">SOURCE DIRECTORY</p><h2>可系统追踪品类价格来源</h2></div><p>DDR、LCD、电池与塑料原材料的集中入口，点击后在新页面打开。</p></div>
          <div className="source-grid">
            {categorySources.map((source) => <a className="source-card" href={source.url} target="_blank" rel="noreferrer" key={`${source.group}-${source.label}`}>
              <span>{source.group}</span><strong>{source.label}</strong><small>{source.source}</small><i>↗</i>
            </a>)}
          </div>
        </section>

        <section className="workflow-section">
          <div className="section-heading"><div><p className="kicker">MAINTENANCE FLOW</p><h2>价格追踪流程</h2></div><p>建议按顺序完成，每次更新后在清单中标记状态。</p></div>
          <div className="workflow">
            {[
              ["01", "确认追踪范围", "核对品类、规格与更新频率"],
              ["02", "采集参考价格", "访问来源并记录价格与日期"],
              ["03", "校验口径", "确认币种、单位与含税口径"],
              ["04", "更新与留痕", "标记状态并保留参考链接"],
            ].map(([num, title, desc], index) => <div className="flow-step" key={num}>
              <span className="step-num">{num}</span><div><h3>{title}</h3><p>{desc}</p></div>{index < 3 && <span className="arrow">→</span>}
            </div>)}
          </div>
        </section>

        <section className="tracker-section">
          <div className="section-heading tracker-heading"><div><p className="kicker">TRACKING MATRIX</p><h2>品类与更新状态</h2></div><div className="legend">{statuses.map((s) => <span key={s}><i className={`dot ${s}`} />{s}</span>)}</div></div>

          <div className="toolbar">
            <label className="search"><span>⌕</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索品类、型号、供应商或来源…" /></label>
            <select value={group} onChange={(e) => setGroup(e.target.value)} aria-label="筛选品类">{groups.map((g) => <option key={g}>{g}</option>)}</select>
            <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="筛选状态"><option>全部状态</option>{statuses.map((s) => <option key={s}>{s}</option>)}</select>
          </div>

          <div className="table-wrap">
            <table>
              <thead><tr><th>品类 / 物料</th><th>型号 / 供应商</th><th>当前价格</th><th>数据状态</th><th>最近更新</th><th>参考来源</th><th>操作</th></tr></thead>
              <tbody>{visible.map((item) => <tr key={item.id}>
                <td><span className="group-label">{item.group}</span><strong>{item.name}</strong></td>
                <td><span className="mpn">{item.mpn}</span><small className="supplier">{item.supplier}</small></td>
                <td><strong className="price">{item.price}</strong><small className="unit">{item.unit}</small></td>
                <td><span className={`status-tag ${item.status}`}><i />{item.status}</span></td>
                <td className="mono">{item.updated}</td>
                <td>{item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.source} ↗</a> : <button className="text-button" onClick={() => openEditor(item)}>＋ 添加参考链接</button>}</td>
                <td><div className="row-actions"><button onClick={() => markUpdated(item.id)} title="标记为今日已更新">✓</button><button onClick={() => openEditor(item)} title="编辑来源">✎</button></div></td>
              </tr>)}</tbody>
            </table>
            {visible.length === 0 && <div className="empty">没有符合当前筛选条件的品类。</div>}
          </div>
          <p className="local-note">所有修改仅保存在此浏览器中 · 建议定期同步到主价格表</p>
        </section>
      </div>

      {editing !== null && <div className="modal-backdrop" onMouseDown={() => setEditing(null)}>
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" onMouseDown={(e) => e.stopPropagation()}>
          <button className="modal-close" onClick={() => setEditing(null)}>×</button>
          <p className="kicker">REFERENCE SOURCE</p><h2 id="modal-title">编辑参考来源</h2>
          <label>来源名称<input value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })} placeholder="例如：TrendForce" /></label>
          <label>参考链接<input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://…" /></label>
          <p>链接留空时，该品类会自动标记为“暂无来源”。</p>
          <div className="modal-actions"><button className="ghost-button" onClick={() => setEditing(null)}>取消</button><button className="primary-button" onClick={saveReference}>保存来源</button></div>
        </div>
      </div>}
    </main>
  );
}
