import React, { useState } from "react";
import { ConfigService } from "../../../assets/lib/kookit-extra-browser.min";
import { hidesPdfContentBackground, pdfContentBackgroundKey } from "../../../utils/reader/pdfContentBackground";
import "./pdfBackgroundSetting.css";

export default function PdfBackgroundSetting({bookKey, renderBook}: {bookKey: string; renderBook: () => void}) {
  const [enabled, setEnabled] = useState(() => hidesPdfContentBackground(bookKey));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const change = async () => {
    setBusy(true); setError("");
    const next = !enabled;
    ConfigService.setReaderConfig(pdfContentBackgroundKey(bookKey), next ? "yes" : "no");
    setEnabled(next);
    try { await renderBook(); }
    catch { setError("设置已保存，页面刷新失败，请关闭并重新打开本书。"); }
    finally { setBusy(false); }
  };
  return <div className="pdf-content-background-setting">
    <div className="single-control-switch-container">
      <span className="single-control-switch-title" id="pdf-content-background-label">隐藏 PDF 内容白底</span>
      <button type="button" className="single-control-switch" role="switch" aria-checked={enabled}
        disabled={busy} onClick={change} aria-labelledby="pdf-content-background-label"
        aria-describedby="pdf-content-background-description" style={{opacity: enabled ? 1 : .6}}>
        <span className="single-control-button" aria-hidden="true" style={{transform:`translateX(${enabled ? 20 : 0}px)`}} />
      </button>
    </div>
    <p id="pdf-content-background-description">仅当前书。隐藏页面开头的大面积白色底板，让阅读主题透出；图片和表格保留原样。</p>
    {error && <p role="alert">{error}</p>}
  </div>;
}
