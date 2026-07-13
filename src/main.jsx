import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as pdfjsLib from "pdfjs-dist";
import Papa from "papaparse";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import {
  ArrowDownToLine,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database,
  Eye,
  FileText,
  Grid2X2,
  Layers,
  ListChecks,
  MousePointer2,
  Plus,
  Rows3,
  Save,
  SlidersHorizontal,
  Table,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  clampRect,
  normalizeRect,
  pdfCropBoxFromRatios,
  ratioRectToPixels,
  rectFromPoints,
  resizedRect,
  screenPointToCanvasPoint,
} from "./utils/coordinates";
import { loadProject, saveProject } from "./utils/storage";
import uiText from "./i18n/ui-text.json";
import "./styles.css";

// pdfjs-dist 5.x may call proposed Map helpers that are missing in older browsers.
if (typeof Map.prototype.getOrInsert !== "function") {
  Map.prototype.getOrInsert = function getOrInsert(key, defaultValue) {
    if (this.has(key)) return this.get(key);
    this.set(key, defaultValue);
    return defaultValue;
  };
}

if (typeof Map.prototype.getOrInsertComputed !== "function") {
  Map.prototype.getOrInsertComputed = function getOrInsertComputed(key, compute) {
    if (this.has(key)) return this.get(key);
    const value = compute(key);
    this.set(key, value);
    return value;
  };
}

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url,
).toString();

const PAPER_SIZES = {
  A4: { width: 595.28, height: 841.89 },
  A3: { width: 841.89, height: 1190.55 },
};

const CSV_ENCODINGS = [
  { value: "auto", label: "Auto" },
  { value: "utf-8", label: "UTF-8" },
  { value: "shift_jis", label: "Shift-JIS / CP932" },
  { value: "big5", label: "Big5" },
  { value: "gb18030", label: "GB18030 / GBK" },
];

const PDF_FONTS = {
  regular: `${import.meta.env.BASE_URL}fonts/NotoSansCJKjp-Regular.otf`,
  bold: `${import.meta.env.BASE_URL}fonts/NotoSansCJKjp-Bold.otf`,
};

const VARIABLE_MIN_PIXELS = 6;
const MAPPING_FUNCTION_PREFIX = "__fn__";
const MAPPING_FUNCTIONS = [
  { key: `${MAPPING_FUNCTION_PREFIX}today_yyyy_mm_dd`, labelKey: "mapping.function.todayYyyyMmDd" },
  { key: `${MAPPING_FUNCTION_PREFIX}today_yyyymmdd`, labelKey: "mapping.function.todayYyyymmdd" },
];

const NAV = [
  { id: "setup", titleKey: "page.setup.title", flowKey: "nav.setup", icon: Layers },
  { id: "templateLibrary", titleKey: "page.templateLibrary.title", flowKey: "nav.templateLibrary", icon: FileText },
  { id: "designer", titleKey: "page.designer.title", flowKey: "nav.designer", icon: MousePointer2 },
  { id: "mapping", titleKey: "page.mapping.title", flowKey: "nav.mapping", icon: Database },
  { id: "layout", titleKey: "page.printSetup.title", flowKey: "nav.print", icon: Grid2X2 },
];

const FLOW = [
  { id: "setup", labelKey: "nav.setup" },
  { id: "templateLibrary", labelKey: "nav.templateLibrary" },
  { id: "designer", labelKey: "nav.designer" },
  { id: "mapping", labelKey: "nav.mapping" },
  { id: "layout", labelKey: "nav.print" },
];

const defaultStyle = {
  fontFamily: "NotoSansCJK",
  fontSize: 18,
  fontWeight: "normal",
  textAlign: "center",
  verticalAlign: "middle",
  color: "#000000",
  backgroundColor: "transparent",
  autoFit: true,
};

const defaultLayout = {
  paperSize: "A4",
  orientation: "portrait",
  rows: 4,
  columns: 2,
  marginX: 24,
  marginY: 24,
  gapX: 10,
  gapY: 10,
  copiesPerRecord: 1,
  sizeMode: "fit",
};

function makeTranslator(language) {
  return (key, params = {}) => {
    const template = uiText[language]?.[key] || uiText.en[key] || key;
    return template.replace(/\{(\w+)\}/g, (_match, token) => String(params[token] ?? `{${token}}`));
  };
}

function App() {
  const [view, setView] = useState("setup");
  const [designerMode, setDesignerMode] = useState("crop");
  const [language, setLanguage] = useState(() => localStorage.getItem("template-print-language") || "en");
  const [templates, setTemplates] = useState([]);
  const [activeTemplateId, setActiveTemplateId] = useState("");
  const [csvDatasets, setCsvDatasets] = useState([]);
  const [activeCsvId, setActiveCsvId] = useState("");
  const [selectedRowIds, setSelectedRowIds] = useState([]);
  const [rowCopies, setRowCopies] = useState({});
  const [previewCsvId, setPreviewCsvId] = useState("");
  const [mappingPreviewOpen, setMappingPreviewOpen] = useState(false);
  const [printPreviewOpen, setPrintPreviewOpen] = useState(() => window.innerWidth > 720);
  const [mappings, setMappings] = useState({});
  const [layout, setLayout] = useState(defaultLayout);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [pageSize, setPageSize] = useState(null);
  const [pdfZoom, setPdfZoom] = useState(1);
  const [renderBox, setRenderBox] = useState({ width: 0, height: 0, scale: 1 });
  const [cropRect, setCropRect] = useState(null);
  const [cropPreviewImageUrl, setCropPreviewImageUrl] = useState("");
  const [cropPreviewDisplaySize, setCropPreviewDisplaySize] = useState(null);
  const [selectedVariableId, setSelectedVariableId] = useState("");
  const [exportUrl, setExportUrl] = useState("");
  const [status, setStatus] = useState("");
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);

  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const cropPreviewRef = useRef(null);
  const dragRef = useRef(null);

  const activeTemplate = templates.find((template) => template.templateId === activeTemplateId) ?? null;
  const activeCsv = csvDatasets.find((dataset) => dataset.id === activeCsvId) ?? null;
  const activeMappingKey = activeTemplate && activeCsv ? mappingKey(activeTemplate.templateId, activeCsv.id) : "";
  const activeMapping = activeMappingKey ? mappings[activeMappingKey] ?? mappings[activeTemplate.templateId] ?? {} : {};
  const selectedVariable = activeTemplate?.variables.find((item) => item.id === selectedVariableId) ?? null;
  const t = useMemo(() => makeTranslator(language), [language]);

  useEffect(() => {
    const saved = loadProject();
    if (!saved) return;
    setTemplates(saved.templates ?? []);
    setActiveTemplateId(saved.activeTemplateId ?? saved.templates?.[0]?.templateId ?? "");
    setCsvDatasets(saved.csvDatasets ?? []);
    setActiveCsvId(saved.activeCsvId ?? saved.csvDatasets?.[0]?.id ?? "");
    setSelectedRowIds(saved.selectedRowIds ?? []);
    setRowCopies(saved.rowCopies ?? {});
    setMappings(saved.mappings ?? {});
    setLayout({ ...defaultLayout, ...(saved.layout ?? {}) });
  }, []);

  useEffect(() => {
    saveProject({ templates, activeTemplateId, csvDatasets, activeCsvId, selectedRowIds, rowCopies, mappings, layout });
  }, [templates, activeTemplateId, csvDatasets, activeCsvId, selectedRowIds, rowCopies, mappings, layout]);

  useEffect(() => {
    localStorage.setItem("template-print-language", language);
  }, [language]);

  useEffect(() => {
    if (!status) return undefined;
    const timeout = window.setTimeout(() => setStatus(""), 4200);
    return () => window.clearTimeout(timeout);
  }, [status]);

  useEffect(() => {
    let cancelled = false;
    async function loadPdf() {
      setPdfDoc(null);
      setPageCount(0);
      setPageSize(null);
      if (!activeTemplate?.sourcePdf?.dataBase64) return;
      const bytes = base64ToArrayBuffer(activeTemplate.sourcePdf.dataBase64);
      const { loaded, normalizedBytes } = await loadPdfJsDocumentWithFallback(bytes.slice(0));
      if (cancelled) return;
      const nextPageNumber = activeTemplate.sourcePdf.pageNumber ?? 1;
      const page = await loaded.getPage(nextPageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const nextPageSize = { width: viewport.width, height: viewport.height };
      if (cancelled) return;
      setPdfDoc(loaded);
      setPageCount(loaded.numPages);
      setPageNumber(nextPageNumber);
      setPageSize(nextPageSize);
      if (normalizedBytes && activeTemplate?.templateId) {
        updateTemplate(activeTemplate.templateId, {
          sourcePdf: {
            ...activeTemplate.sourcePdf,
            dataBase64: arrayBufferToBase64(normalizedBytes),
          },
        });
      }
      if (!activeTemplate.sourcePdf.pageSize) {
        updateTemplate(activeTemplate.templateId, {
          sourcePdf: { ...activeTemplate.sourcePdf, pageSize: nextPageSize },
        });
      }
    }
    loadPdf().catch((error) => setStatus(error.message));
    return () => {
      cancelled = true;
    };
  }, [activeTemplateId]);

  useEffect(() => {
    let cancelled = false;
    async function renderPage() {
      if (!pdfDoc || !canvasRef.current) return;
      const page = await pdfDoc.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const cropWorkspaceReserve = view === "designer" && designerMode === "crop" ? 380 : 620;
      const minCanvasWidth = window.innerWidth < 720 ? Math.max(240, window.innerWidth - 32) : 420;
      const maxWidth = Math.min(1240, Math.max(minCanvasWidth, window.innerWidth - cropWorkspaceReserve));
      const fitScale = Math.max(0.35, Math.min(1.8, maxWidth / baseViewport.width));
      const scale = Math.max(0.35, Math.min(3, fitScale * pdfZoom));
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d");
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(viewport.width * dpr);
      canvas.height = Math.round(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      await page.render({ canvasContext: context, viewport }).promise;
      if (cancelled) return;
      const nextPageSize = { width: baseViewport.width, height: baseViewport.height };
      const nextRenderBox = { width: viewport.width, height: viewport.height, scale };
      setPageSize(nextPageSize);
      setRenderBox(nextRenderBox);
      setCropRect(activeTemplate?.cropArea ? ratioRectToPixels(activeTemplate.cropArea, viewport.width, viewport.height) : null);
    }
    renderPage().catch((error) => setStatus(error.message));
    return () => {
      cancelled = true;
    };
  }, [view, designerMode, pdfDoc, pageNumber, activeTemplate?.cropArea, pdfZoom]);

  useEffect(() => {
    requestAnimationFrame(() => drawCropPreview());
  }, [view, activeTemplate?.cropArea, activeTemplate?.variables, renderBox, pdfDoc, pageNumber]);

  function setCropPreviewNode(node) {
    cropPreviewRef.current = node;
    if (node) requestAnimationFrame(() => drawCropPreview());
  }

  async function handlePdfUpload(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.type !== "application/pdf") {
      setStatus(t("status.uploadPdfOnly"));
      return;
    }
    const bytes = await file.arrayBuffer();
    const templateId = crypto.randomUUID();
    const template = {
      templateId,
      templateName: file.name.replace(/\.pdf$/i, ""),
      sourcePdf: {
        fileName: file.name,
        pageNumber: 1,
        dataBase64: arrayBufferToBase64(bytes),
      },
      cropArea: null,
      variables: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setTemplates((items) => [template, ...items]);
    setActiveTemplateId(templateId);
    setPageNumber(1);
    setPageCount(0);
    setPdfDoc(null);
    setRenderBox({ width: 0, height: 0, scale: 1 });
    setCropRect(null);
    setSelectedVariableId("");
    setDesignerMode("crop");
    setView("designer");
    setStatus(t("status.pdfUploaded"));
  }

  function updateTemplate(templateId, patch) {
    setTemplates((items) =>
      items.map((item) =>
        item.templateId === templateId ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item,
      ),
    );
  }

  function createTemplateFromActivePdf() {
    if (!activeTemplate?.sourcePdf?.dataBase64) {
      setStatus(t("status.selectPdfFirst"));
      return;
    }
    const existingForPdf = templates.filter((template) => template.sourcePdf.fileName === activeTemplate.sourcePdf.fileName).length;
    const templateId = crypto.randomUUID();
    const template = {
      templateId,
      templateName: `${activeTemplate.sourcePdf.fileName.replace(/\.pdf$/i, "")} ${t("template.cropSuffix", { count: existingForPdf + 1 })}`,
      sourcePdf: {
        ...activeTemplate.sourcePdf,
        pageNumber,
      },
      cropArea: null,
      variables: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setTemplates((items) => [template, ...items]);
    setActiveTemplateId(templateId);
    setCropRect(null);
    setSelectedVariableId("");
    setDesignerMode("crop");
    setView("designer");
    setStatus(t("status.newTemplateFromPdf"));
  }

  function saveCrop() {
    if (!activeTemplate || !cropRect || !renderBox.width || !renderBox.height) return;
    const cropArea = normalizeRect(cropRect, renderBox.width, renderBox.height);
    updateTemplate(activeTemplate.templateId, {
      cropArea,
      sourcePdf: { ...activeTemplate.sourcePdf, pageNumber, pageSize },
    });
    setDesignerMode("fields");
    setView("designer");
    setStatus(t("status.cropSavedAddVariables"));
  }

  function beginCropCreate(event) {
    if (!overlayRef.current || event.target !== event.currentTarget) return;
    event.preventDefault();
    const start = screenPointToCanvasPoint(event, overlayRef.current);
    dragRef.current = { kind: "crop-create", start };
    setCropRect({ x: start.x, y: start.y, width: 1, height: 1 });
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", endPointerDrag);
  }

  function beginCropDrag(event, mode = "move") {
    if (!cropRect || !overlayRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const point = screenPointToCanvasPoint(event, overlayRef.current);
    dragRef.current = { kind: "crop", mode, start: point, initial: cropRect };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", endPointerDrag);
  }

  function beginVariableDrag(event, variableId, mode = "move") {
    if (!cropPreviewRef.current || !activeTemplate) return;
    event.preventDefault();
    event.stopPropagation();
    const variable = activeTemplate.variables.find((item) => item.id === variableId);
    if (!variable) return;
    setSelectedVariableId(variableId);
    const point = screenPointToCanvasPoint(event, cropPreviewRef.current);
    const pixelRect = ratioRectToPixels(variable, cropPreviewRef.current.clientWidth, cropPreviewRef.current.clientHeight);
    dragRef.current = { kind: "variable", mode, variableId, start: point, initial: pixelRect };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", endPointerDrag);
  }

  function handlePointerMove(event) {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.kind === "crop-create" && overlayRef.current) {
      const point = screenPointToCanvasPoint(event, overlayRef.current);
      setCropRect(clampRect(rectFromPoints(drag.start, point), renderBox.width, renderBox.height));
    }
    if (drag.kind === "crop" && overlayRef.current) {
      const point = screenPointToCanvasPoint(event, overlayRef.current);
      setCropRect(clampRect(resizedRect(drag.initial, drag.start, point, drag.mode), renderBox.width, renderBox.height));
    }
    if (drag.kind === "variable" && cropPreviewRef.current && activeTemplate) {
      const point = screenPointToCanvasPoint(event, cropPreviewRef.current);
      const next = clampRect(
        resizedRect(drag.initial, drag.start, point, drag.mode, VARIABLE_MIN_PIXELS),
        cropPreviewRef.current.clientWidth,
        cropPreviewRef.current.clientHeight,
        VARIABLE_MIN_PIXELS,
      );
      const normalized = normalizeRect(next, cropPreviewRef.current.clientWidth, cropPreviewRef.current.clientHeight);
      updateVariable(drag.variableId, normalized);
    }
  }

  function endPointerDrag() {
    dragRef.current = null;
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", endPointerDrag);
  }

  async function drawCropPreview() {
    if (!pdfDoc || !activeTemplate?.cropArea) {
      setCropPreviewImageUrl("");
      setCropPreviewDisplaySize(null);
      return;
    }
    try {
      const previewPageNumber = activeTemplate.sourcePdf?.pageNumber ?? pageNumber;
      const page = await pdfDoc.getPage(previewPageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const cropPixels = ratioRectToPixels(activeTemplate.cropArea, baseViewport.width, baseViewport.height);
    const minPreviewWidth = window.innerWidth < 720 ? Math.max(220, window.innerWidth - 44) : 360;
    const displayWidth = Math.min(980, Math.max(minPreviewWidth, cropPixels.width * Math.max(renderBox.scale, 1)));
    const displayScale = displayWidth / cropPixels.width;
    const qualityScale = Math.max(2, Math.min(4, window.devicePixelRatio || 2));
    const scale = displayScale * qualityScale;
    const viewport = page.getViewport({ scale });
    const offscreen = document.createElement("canvas");
    offscreen.width = viewport.width;
    offscreen.height = viewport.height;
    await page.render({ canvasContext: offscreen.getContext("2d"), viewport }).promise;
    const targetWidth = Math.round(cropPixels.width * scale);
    const targetHeight = Math.round(cropPixels.height * scale);
    const displayHeight = Math.round(cropPixels.height * displayScale);
    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = targetWidth;
    cropCanvas.height = targetHeight;
    const cropContext = cropCanvas.getContext("2d");
    cropContext.drawImage(
      offscreen,
      cropPixels.x * scale,
      cropPixels.y * scale,
      cropPixels.width * scale,
      cropPixels.height * scale,
      0,
      0,
      targetWidth,
      targetHeight,
    );
    setCropPreviewDisplaySize({ width: Math.round(displayWidth), height: displayHeight });
    setCropPreviewImageUrl(cropCanvas.toDataURL("image/png"));
    const canvas = cropPreviewRef.current?.querySelector("canvas");
    if (!canvas) return;
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    canvas.style.width = `${Math.round(displayWidth)}px`;
    canvas.style.height = `${displayHeight}px`;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(cropCanvas, 0, 0);
    } catch (error) {
      setCropPreviewImageUrl("");
      setCropPreviewDisplaySize(null);
      setStatus(t("status.cropPreviewFailed", { message: error.message }));
    }
  }

  function addVariable() {
    if (!activeTemplate?.cropArea) {
      setStatus(t("status.saveCropBeforeVariables"));
      return;
    }
    const id = crypto.randomUUID();
    const fieldName = `field_${activeTemplate.variables.length + 1}`;
    const next = {
      id,
      key: fieldName,
      displayName: fieldName,
      type: "text",
      xRatio: 0.1,
      yRatio: 0.1,
      widthRatio: 0.35,
      heightRatio: 0.16,
      style: { ...defaultStyle },
    };
    updateTemplate(activeTemplate.templateId, { variables: [...activeTemplate.variables, next] });
    setSelectedVariableId(id);
  }

  function duplicateVariable(variableId = selectedVariableId) {
    if (!activeTemplate?.cropArea || !variableId) return;
    const source = activeTemplate.variables.find((item) => item.id === variableId);
    if (!source) return;
    const id = crypto.randomUUID();
    const fieldName = `field_${activeTemplate.variables.length + 1}`;
    const next = {
      ...source,
      id,
      key: fieldName,
      displayName: fieldName,
      xRatio: Math.min(0.95 - source.widthRatio, source.xRatio + 0.02),
      yRatio: Math.min(0.95 - source.heightRatio, source.yRatio + 0.02),
      style: { ...source.style },
    };
    updateTemplate(activeTemplate.templateId, { variables: [...activeTemplate.variables, next] });
    setSelectedVariableId(id);
  }

  function updateVariable(variableId, patch) {
    if (!activeTemplate) return;
    updateTemplate(activeTemplate.templateId, {
      variables: activeTemplate.variables.map((item) => (item.id === variableId ? { ...item, ...patch } : item)),
    });
  }

  function updateSelectedVariable(patch) {
    if (selectedVariableId) updateVariable(selectedVariableId, patch);
  }

  function updateSelectedVariableStyle(patch) {
    if (!selectedVariableId || !selectedVariable) return;
    updateVariable(selectedVariableId, { style: { ...selectedVariable.style, ...patch } });
  }

  function deleteVariable(variableId) {
    if (!activeTemplate) return;
    updateTemplate(activeTemplate.templateId, {
      variables: activeTemplate.variables.filter((item) => item.id !== variableId),
    });
    if (selectedVariableId === variableId) setSelectedVariableId("");
  }

  async function handleCsvUpload(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const decoded = await decodeCsvFile(file, "auto");
      const result = Papa.parse(decoded.text, { header: true, skipEmptyLines: true });
      if (result.errors?.length) throw new Error(result.errors[0].message);
      const id = crypto.randomUUID();
      const fields = result.meta.fields ?? [];
      const dataset = {
        id,
        name: file.name.replace(/\.csv$/i, ""),
        fileName: file.name,
        headers: fields,
        rows: result.data,
        encoding: decoded.encoding,
        encodingDetected: decoded.detected,
        createdAt: new Date().toISOString(),
      };
      setCsvDatasets((items) => [dataset, ...items]);
      setActiveCsvId(id);
      setPreviewCsvId("");
      setSelectedRowIds(result.data.map((_, index) => String(index)));
      setRowCopies(result.data.reduce((copies, _row, index) => ({ ...copies, [index]: 1 }), {}));
      if (activeTemplate) {
        const nextKey = mappingKey(activeTemplate.templateId, id);
        setMappings((current) => ({
          ...current,
          [nextKey]: autoMapping(activeTemplate.variables, fields, current[nextKey]),
        }));
      }
      setView("setup");
      setStatus(t("status.csvSaved", { count: result.data.length, encoding: encodingLabel(decoded.encoding) }));
    } catch (error) {
      setStatus(error.message);
    }
  }

  function updateMapping(variableId, header) {
    if (!activeTemplate || !activeCsv) return;
    const nextKey = mappingKey(activeTemplate.templateId, activeCsv.id);
    setMappings((current) => ({
      ...current,
      [nextKey]: {
        ...(current[nextKey] ?? {}),
        [variableId]: header,
      },
    }));
  }

  async function getActiveTemplatePageSize() {
    if (!activeTemplate?.sourcePdf?.dataBase64) return null;
    if (pageSize) return pageSize;
    const loadingTask = pdfjsLib.getDocument({ data: base64ToArrayBuffer(activeTemplate.sourcePdf.dataBase64).slice(0) });
    const loaded = await loadingTask.promise;
    const page = await loaded.getPage(activeTemplate.sourcePdf.pageNumber ?? 1);
    const viewport = page.getViewport({ scale: 1 });
    return { width: viewport.width, height: viewport.height };
  }

  async function autoLayout() {
    if (!activeTemplate?.cropArea) return;
    const templatePageSize = await getActiveTemplatePageSize();
    if (!templatePageSize) return;
    const cropPoints = {
      width: activeTemplate.cropArea.widthRatio * templatePageSize.width,
      height: activeTemplate.cropArea.heightRatio * templatePageSize.height,
    };
    const margin = 18;
    const gap = 8;
    const candidates = ["portrait", "landscape"].map((orientation) => {
      const paper = orientedPaper({ ...layout, orientation });
      const columns = Math.max(1, Math.floor((paper.width - margin * 2 + gap) / (cropPoints.width + gap)));
      const rows = Math.max(1, Math.floor((paper.height - margin * 2 + gap) / (cropPoints.height + gap)));
      return { orientation, rows, columns, slots: rows * columns };
    });
    const best = candidates.sort((a, b) => b.slots - a.slots)[0];
    setLayout((current) => ({
      ...current,
      orientation: best.orientation,
      rows: best.rows,
      columns: best.columns,
      marginX: margin,
      marginY: margin,
      gapX: gap,
      gapY: gap,
      sizeMode: "actual",
    }));
  }

  function openDesignerForTemplate(templateId, mode = "crop") {
    const template = templates.find((item) => item.templateId === templateId);
    setActiveTemplateId(templateId);
    if (template?.sourcePdf?.pageNumber) setPageNumber(template.sourcePdf.pageNumber);
    setSelectedVariableId("");
    setDesignerMode(mode);
    setView("designer");
  }

  function removeCrop(templateId) {
    const template = templates.find((item) => item.templateId === templateId);
    if (!template) return;
    const ok = window.confirm(t("confirm.removeCrop"));
    if (!ok) return;
    updateTemplate(templateId, { cropArea: null, variables: [] });
    if (templateId === activeTemplateId) {
      setCropRect(null);
      setSelectedVariableId("");
      setDesignerMode("crop");
    }
    setStatus(t("status.cropRemoved"));
  }

  function deleteTemplate(templateId) {
    const template = templates.find((item) => item.templateId === templateId);
    if (!template) return;
    const ok = window.confirm(t("confirm.deleteTemplate", { name: template.templateName }));
    if (!ok) return;
    const remaining = templates.filter((item) => item.templateId !== templateId);
    setTemplates(remaining);
    setMappings((current) => Object.fromEntries(
      Object.entries(current).filter(([key]) => !key.startsWith(`${templateId}::`)),
    ));
    if (activeTemplateId === templateId) {
      const nextTemplate = remaining[0] ?? null;
      setActiveTemplateId(nextTemplate?.templateId ?? "");
      setSelectedVariableId("");
      setCropRect(null);
      setCropPreviewImageUrl("");
      setPdfDoc(null);
      setPageNumber(nextTemplate?.sourcePdf?.pageNumber ?? 1);
      setPageCount(0);
      setPageSize(null);
    }
    setStatus(t("status.templateDeleted", { name: template.templateName }));
  }

  function deleteCsvDataset(csvId) {
    const dataset = csvDatasets.find((item) => item.id === csvId);
    if (!dataset) return;
    const ok = window.confirm(t("confirm.deleteCsv", { name: dataset.name }));
    if (!ok) return;
    const remaining = csvDatasets.filter((item) => item.id !== csvId);
    setCsvDatasets(remaining);
    setMappings((current) => Object.fromEntries(
      Object.entries(current).filter(([key]) => !key.endsWith(`::${csvId}`)),
    ));
    if (previewCsvId === csvId) setPreviewCsvId("");
    if (activeCsvId === csvId) {
      const nextDataset = remaining[0] ?? null;
      setActiveCsvId(nextDataset?.id ?? "");
      setSelectedRowIds(nextDataset ? nextDataset.rows.map((_, index) => String(index)) : []);
      setRowCopies(nextDataset ? nextDataset.rows.reduce((copies, _row, index) => ({ ...copies, [index]: 1 }), {}) : {});
    }
    setStatus(t("status.csvDeleted", { name: dataset.name }));
  }

  function exportTemplateFile(templateId) {
    const template = templates.find((item) => item.templateId === templateId);
    if (!template) return;
    const packageData = {
      format: "printtpl-json-v1",
      exportedAt: new Date().toISOString(),
      template: {
        templateName: template.templateName,
        sourcePdf: template.sourcePdf,
        cropArea: template.cropArea,
        variables: template.variables,
      },
    };
    const blob = new Blob([JSON.stringify(packageData, null, 2)], { type: "application/json" });
    const fileName = `${safeFileName(template.templateName || "template")}.printtpl`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importTemplateFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const imported = parsed?.template;
      if (!imported?.sourcePdf?.dataBase64 || !Array.isArray(imported?.variables)) {
        throw new Error(t("status.templateImportInvalid"));
      }
      const nextTemplate = {
        templateId: crypto.randomUUID(),
        templateName: imported.templateName || file.name.replace(/\.printtpl$/i, ""),
        sourcePdf: imported.sourcePdf,
        cropArea: imported.cropArea ?? null,
        variables: imported.variables,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setTemplates((items) => [nextTemplate, ...items]);
      setActiveTemplateId(nextTemplate.templateId);
      setStatus(t("status.templateImported", { name: nextTemplate.templateName }));
    } catch (error) {
      setStatus(error.message || t("status.templateImportInvalid"));
    }
  }

  async function generatePdf({ openAfter = false, downloadAfter = false } = {}) {
    if (!activeTemplate?.sourcePdf?.dataBase64 || !activeTemplate.cropArea) {
      setStatus(t("status.selectTemplateBeforeExport"));
      return "";
    }
    if (!activeTemplate.variables.length) {
      setStatus(t("status.addVariableBeforeExport"));
      return "";
    }
    setIsGeneratingPdf(true);
    try {
    setStatus(t("status.preparingSourcePdf"));
    const sourceDoc = await PDFDocument.load(base64ToArrayBuffer(activeTemplate.sourcePdf.dataBase64));
    const outputDoc = await PDFDocument.create();
    outputDoc.registerFontkit(fontkit);
    setStatus(t("status.loadingExportFonts"));
    const { regularFont, boldFont } = await loadPdfFonts(outputDoc);
    setStatus(t("status.composingPrintablePdf"));
    const sourcePage = sourceDoc.getPages()[(activeTemplate.sourcePdf.pageNumber ?? 1) - 1];
    const sourcePageSize = sourcePage.getSize();
    const crop = pdfCropBoxFromRatios(activeTemplate.cropArea, sourcePageSize.width, sourcePageSize.height);
    const embeddedPage = await outputDoc.embedPage(sourcePage, {
      left: crop.x,
      bottom: crop.y,
      right: crop.x + crop.width,
      top: crop.y + crop.height,
    });
    const paper = orientedPaper(layout);
    const cellWidth = (paper.width - layout.marginX * 2 - layout.gapX * (layout.columns - 1)) / layout.columns;
    const cellHeight = (paper.height - layout.marginY * 2 - layout.gapY * (layout.rows - 1)) / layout.rows;
    const scale = layout.sizeMode === "actual" ? 1 : Math.min(cellWidth / crop.width, cellHeight / crop.height);
    const itemWidth = crop.width * scale;
    const itemHeight = crop.height * scale;
    const printableRows = getPrintableRowEntries(activeCsv, selectedRowIds);
    const records = expandRowEntries(printableRows.length ? printableRows : [{ row: {}, index: 0 }], rowCopies).map((entry) => entry.row);
    let outputPage = outputDoc.addPage([paper.width, paper.height]);
    records.forEach((row, index) => {
      const slot = index % (layout.rows * layout.columns);
      if (index > 0 && slot === 0) outputPage = outputDoc.addPage([paper.width, paper.height]);
      const column = slot % layout.columns;
      const rowIndex = Math.floor(slot / layout.columns);
      const x = layout.marginX + column * (cellWidth + layout.gapX) + (cellWidth - itemWidth) / 2;
      const y = paper.height - layout.marginY - (rowIndex + 1) * cellHeight - rowIndex * layout.gapY + (cellHeight - itemHeight) / 2;
      outputPage.drawPage(embeddedPage, { x, y, width: itemWidth, height: itemHeight });
      activeTemplate.variables.forEach((variable) => {
        const source = activeMapping[variable.id];
        const value = resolveMappedValue(source, row);
        const text = String(value !== "" ? value : variable.displayName ?? "");
        const drawFont = variable.style.fontWeight === "bold" ? boldFont : regularFont;
        const box = {
          x: x + variable.xRatio * itemWidth,
          y: y + itemHeight - (variable.yRatio + variable.heightRatio) * itemHeight,
          width: variable.widthRatio * itemWidth,
          height: variable.heightRatio * itemHeight,
        };
        const baseSize = Math.max(4, variable.style.fontSize * scale);
        const size = fitFontSize(text, baseSize, box.width, box.height, variable.style.autoFit, drawFont);
        if (variable.style.backgroundColor && variable.style.backgroundColor !== "transparent") {
          outputPage.drawRectangle({
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            color: hexToRgb(variable.style.backgroundColor),
          });
        }
        outputPage.drawText(text, {
          x: alignX(box, drawFont.widthOfTextAtSize(text, size), variable.style.textAlign),
          y: alignY(box, size, variable.style.verticalAlign),
          size,
          font: drawFont,
          color: hexToRgb(variable.style.color),
        });
      });
    });
    const bytes = await outputDoc.save();
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    const nextUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    setExportUrl(nextUrl);
    setStatus(t("status.printablePdfGenerated"));
    if (openAfter) window.open(nextUrl, "_blank", "noopener,noreferrer");
    if (downloadAfter) downloadBlobUrl(nextUrl, "template-print-output.pdf");
    return nextUrl;
    } finally {
      setIsGeneratingPdf(false);
    }
  }

  async function openPdfForPrint() {
    const placeholder = window.open("about:blank", "_blank");
    if (placeholder) {
      placeholder.document.open();
      placeholder.document.write(printWindowHtml(t, "printWindow.generatingTitle", ""));
      placeholder.document.close();
    }
    try {
      const nextUrl = await generatePdf();
      if (placeholder && nextUrl) {
        placeholder.document.open();
        placeholder.document.write(printWindowHtml(t, "printWindow.printableTitle", nextUrl));
        placeholder.document.close();
      } else if (nextUrl) {
        setStatus(t("status.printTabBlocked"));
      } else if (placeholder) {
        placeholder.document.body.innerHTML = `<p style='font-family:sans-serif;padding:24px'>${escapeHtml(t("printWindow.pdfNotGenerated"))}</p>`;
      }
    } catch (error) {
      if (placeholder) {
        placeholder.document.body.innerHTML = `<p style="font-family:sans-serif;padding:24px;color:#a43f34">${escapeHtml(t("printWindow.pdfGenerationFailed", { message: error.message }))}</p>`;
      }
      setStatus(error.message);
    }
  }

  const cropDebug = cropRect && pageSize ? {
    screen: cropRect,
    ratios: normalizeRect(cropRect, renderBox.width || 1, renderBox.height || 1),
    pdf: pdfCropBoxFromRatios(normalizeRect(cropRect, renderBox.width || 1, renderBox.height || 1), pageSize.width, pageSize.height),
  } : null;

  const pageTitle = t(NAV.find((item) => item.id === view)?.titleKey ?? "page.templates.title");
  const flowStatus = getFlowStatus(activeTemplate, activeCsv, activeMapping, selectedRowIds);

  return (
    <div className="app-shell">
      <main className="main">
        <div className="top-chrome">
          <header className="page-header">
            <div className="page-heading">
              <FileText size={28} />
              <div>
                <p className="eyebrow">{t("app.title")}</p>
                <h2>{pageTitle}</h2>
              </div>
            </div>
            <div className="header-actions">
              {status && <p className="status">{status}</p>}
              <label className="language-select">
                <span>{t("language.label")}</span>
                <select value={language} onChange={(event) => setLanguage(event.target.value)}>
                  <option value="en">{t("language.en")}</option>
                  <option value="ja">{t("language.ja")}</option>
                </select>
              </label>
            </div>
          </header>
          <FlowBar view={view} setView={setView} flowStatus={flowStatus} t={t} />
        </div>

        {view === "setup" && (
          <SetupPage
            templates={templates}
            activeTemplateId={activeTemplateId}
            setActiveTemplateId={setActiveTemplateId}
            updateTemplate={updateTemplate}
            onPdfUpload={handlePdfUpload}
            onCreateTemplateFromActivePdf={createTemplateFromActivePdf}
            canCreateFromActivePdf={Boolean(activeTemplate?.sourcePdf?.dataBase64)}
            openDesignerForTemplate={openDesignerForTemplate}
            removeCrop={removeCrop}
            deleteTemplate={deleteTemplate}
            datasets={csvDatasets}
            activeCsvId={activeCsvId}
            setActiveCsvId={setActiveCsvId}
            previewCsvId={previewCsvId}
            setPreviewCsvId={setPreviewCsvId}
            onCsvUpload={handleCsvUpload}
            deleteCsvDataset={deleteCsvDataset}
            t={t}
          />
        )}
        {view === "templateLibrary" && (
          <TemplateLibraryPage
            templates={templates}
            activeTemplateId={activeTemplateId}
            setActiveTemplateId={setActiveTemplateId}
            exportTemplateFile={exportTemplateFile}
            importTemplateFile={importTemplateFile}
            t={t}
          />
        )}
        {view === "designer" && (
          <DesignerPage
            templates={templates}
            activeTemplateId={activeTemplateId}
            setActiveTemplateId={setActiveTemplateId}
            template={activeTemplate}
            designerMode={designerMode}
            setDesignerMode={setDesignerMode}
            canvasRef={canvasRef}
            overlayRef={overlayRef}
            renderBox={renderBox}
            cropRect={cropRect}
            cropDebug={cropDebug}
            pdfZoom={pdfZoom}
            setPdfZoom={setPdfZoom}
            pageNumber={pageNumber}
            pageCount={pageCount}
            setPageNumber={setPageNumber}
            beginCropCreate={beginCropCreate}
            beginCropDrag={beginCropDrag}
            saveCrop={saveCrop}
            clearCrop={() => setCropRect(null)}
            onPdfUpload={handlePdfUpload}
            cropPreviewRef={setCropPreviewNode}
            selectedVariableId={selectedVariableId}
            setSelectedVariableId={setSelectedVariableId}
            selectedVariable={selectedVariable}
            beginVariableDrag={beginVariableDrag}
            addVariable={addVariable}
            duplicateVariable={duplicateVariable}
            deleteVariable={deleteVariable}
            updateVariable={updateSelectedVariable}
            updateVariableStyle={updateSelectedVariableStyle}
            cropPreviewImageUrl={cropPreviewImageUrl}
            cropPreviewDisplaySize={cropPreviewDisplaySize}
            t={t}
          />
        )}
        {view === "mapping" && (
          <MappingPage
            template={activeTemplate}
            dataset={activeCsv}
            mapping={activeMapping}
            updateMapping={updateMapping}
            templates={templates}
            activeTemplateId={activeTemplateId}
            setActiveTemplateId={setActiveTemplateId}
            csvDatasets={csvDatasets}
            activeCsvId={activeCsvId}
            setActiveCsvId={setActiveCsvId}
            cropPreviewRef={setCropPreviewNode}
            previewOpen={mappingPreviewOpen}
            setPreviewOpen={setMappingPreviewOpen}
            cropPreviewImageUrl={cropPreviewImageUrl}
            cropPreviewDisplaySize={cropPreviewDisplaySize}
            t={t}
          />
        )}
        {view === "layout" && (
          <LayoutPage
            template={activeTemplate}
            dataset={activeCsv}
            mapping={activeMapping}
            templates={templates}
            activeTemplateId={activeTemplateId}
            setActiveTemplateId={setActiveTemplateId}
            csvDatasets={csvDatasets}
            activeCsvId={activeCsvId}
            setActiveCsvId={setActiveCsvId}
            selectedRowIds={selectedRowIds}
            setSelectedRowIds={setSelectedRowIds}
            rowCopies={rowCopies}
            setRowCopies={setRowCopies}
            cropPreviewRef={setCropPreviewNode}
            layout={layout}
            setLayout={setLayout}
            autoLayout={autoLayout}
            generatePdf={generatePdf}
            openPdfForPrint={openPdfForPrint}
            exportUrl={exportUrl}
            isGeneratingPdf={isGeneratingPdf}
            previewOpen={printPreviewOpen}
            setPreviewOpen={setPrintPreviewOpen}
            cropPreviewImageUrl={cropPreviewImageUrl}
            setView={setView}
            pageSize={pageSize}
            t={t}
          />
        )}
      </main>
    </div>
  );
}

function TemplateLibraryPage({ templates, activeTemplateId, setActiveTemplateId, exportTemplateFile, importTemplateFile, t }) {
  return (
    <section className="page-grid single-column">
      <div className="section-card">
        <div className="section-head">
          <div>
            <h3>{t("page.templateLibrary.title")}</h3>
            <p className="muted">{t("templates.packageHelp")}</p>
          </div>
          <label className="button primary">
            <Upload size={16} /> {t("button.uploadTemplate")}
            <input type="file" accept=".printtpl,application/json" onChange={importTemplateFile} />
          </label>
        </div>
        <div className="template-list">
          {templates.length === 0 && <EmptyState title={t("source.noTemplates")} text={t("source.noTemplatesText")} />}
          {templates.map((template) => (
            <article key={template.templateId} className={`template-row ${template.templateId === activeTemplateId ? "active" : ""}`}>
              <button className="template-row-main" onClick={() => setActiveTemplateId(template.templateId)}>
                <span>{template.sourcePdf.fileName}</span>
                <span>
                  {t("source.page")} {template.sourcePdf.pageNumber ?? 1} · {template.cropArea ? t("source.cropSaved") : t("source.needsCrop")} · {template.variables.length} {t("source.variables")}
                </span>
              </button>
              <input className="template-name-input" value={template.templateName} readOnly />
              <div className="template-row-actions">
                <button onClick={() => exportTemplateFile(template.templateId)}>
                  <ArrowDownToLine size={16} /> {t("button.saveTemplate")}
                </button>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function SetupPage({
  templates,
  activeTemplateId,
  setActiveTemplateId,
  updateTemplate,
  onPdfUpload,
  onCreateTemplateFromActivePdf,
  canCreateFromActivePdf,
  openDesignerForTemplate,
  removeCrop,
  deleteTemplate,
  datasets,
  activeCsvId,
  setActiveCsvId,
  previewCsvId,
  setPreviewCsvId,
  onCsvUpload,
  deleteCsvDataset,
  t,
}) {
  const previewDataset = datasets.find((dataset) => dataset.id === previewCsvId);
  return (
    <section className="setup-grid">
      <div className="section-card">
        <div className="section-head">
          <div>
            <h3>{t("page.templates.title")}</h3>
            <p className="muted">{t("templates.savedLocalText")}</p>
          </div>
          <label className="button primary">
            <Plus size={16} /> {t("button.uploadPdf")}
            <input type="file" accept="application/pdf" onChange={onPdfUpload} />
          </label>
          <button disabled={!canCreateFromActivePdf} onClick={onCreateTemplateFromActivePdf}>
            <Plus size={16} /> {t("button.newCrop")}
          </button>
        </div>
        <div className="template-list">
          {templates.length === 0 && <EmptyState title={t("source.noTemplates")} text={t("source.noTemplatesText")} />}
          {templates.map((template) => (
            <article key={template.templateId} className={`template-row ${template.templateId === activeTemplateId ? "active" : ""}`}>
              <button className="template-row-main" onClick={() => setActiveTemplateId(template.templateId)}>
                <span>{template.sourcePdf.fileName}</span>
                <span>
                  {t("source.page")} {template.sourcePdf.pageNumber ?? 1} · {template.cropArea ? t("source.cropSaved") : t("source.needsCrop")} · {template.variables.length} {t("source.variables")}
                </span>
              </button>
              <input
                className="template-name-input"
                value={template.templateName}
                onChange={(event) => updateTemplate(template.templateId, { templateName: event.target.value })}
              />
              <div className="template-row-actions">
                <button
                  aria-label={template.cropArea ? t("source.editDesign") : t("source.designCrop")}
                  title={template.cropArea ? t("source.editDesign") : t("source.designCrop")}
                  onClick={() => openDesignerForTemplate(template.templateId, template.cropArea ? "fields" : "crop")}
                >
                  <MousePointer2 size={16} /> {template.cropArea ? t("source.editDesign") : t("source.designCrop")}
                </button>
                <button
                  aria-label={t("source.showCrop")}
                  title={t("source.showCrop")}
                  disabled={!template.cropArea}
                  onClick={() => openDesignerForTemplate(template.templateId, "fields")}
                >
                  <Eye size={16} /> {t("source.showCrop")}
                </button>
                <button
                  aria-label={t("source.removeCrop")}
                  className="danger"
                  title={t("source.removeCrop")}
                  disabled={!template.cropArea}
                  onClick={() => removeCrop(template.templateId)}
                >
                  <X size={16} /> {t("source.removeCrop")}
                </button>
                <button
                  aria-label={t("button.deleteTemplate")}
                  className="danger"
                  title={t("button.deleteTemplate")}
                  onClick={() => deleteTemplate(template.templateId)}
                >
                  <Trash2 size={16} /> {t("button.deleteTemplate")}
                </button>
              </div>
            </article>
          ))}
        </div>
      </div>

      <div className="section-card">
        <div className="section-head">
          <div>
            <h3>{t("page.csv.title")}</h3>
            <p className="muted">{t("csv.savedDatasetsText")}</p>
          </div>
          <div className="csv-upload-tools">
            <label className="button primary">
              <Upload size={16} /> {t("button.uploadCsv")}
              <input type="file" accept=".csv,text/csv" onChange={onCsvUpload} />
            </label>
          </div>
        </div>
        <div className="csv-list">
          {datasets.length === 0 && <EmptyState title={t("csv.noDatasets")} text={t("csv.noDatasetsText")} />}
          {datasets.map((dataset) => (
            <article key={dataset.id} className={`csv-row ${dataset.id === activeCsvId ? "active" : ""}`}>
              <button className="csv-row-main" onClick={() => setActiveCsvId(dataset.id)}>
                <strong>{dataset.name}</strong>
                <span>
                  {dataset.fileName} · {dataset.rows.length} rows · {dataset.headers.length} columns · {encodingLabel(dataset.encoding)}
                  {dataset.encodingDetected ? ` ${t("csv.autoDetected")}` : ""}
                </span>
              </button>
              <div className="csv-row-actions">
                <button className="preview-button" onClick={() => setPreviewCsvId(previewCsvId === dataset.id ? "" : dataset.id)}>
                  <Eye size={16} />
                  {previewCsvId === dataset.id ? t("button.close") : t("button.preview")}
                </button>
                <button className="danger" onClick={() => deleteCsvDataset(dataset.id)}>
                  <Trash2 size={16} /> {t("button.deleteCsv")}
                </button>
              </div>
            </article>
          ))}
        </div>
        {previewCsvId ? (
          <div className="embedded-preview">
            <div className="panel-head">
              <div>
                <h3>{t("preview.csv")}</h3>
                <p className="muted">{previewDataset?.name}</p>
              </div>
              <button className="icon-button" title={t("preview.closeCsv")} onClick={() => setPreviewCsvId("")}><X size={16} /></button>
            </div>
            <CsvPreview dataset={previewDataset} t={t} />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function SidebarActions({ onPdfUpload, onCreateTemplateFromActivePdf, canCreateFromActivePdf, onCsvUpload }) {
  return (
    <div className="sidebar-actions">
      <div className="quick-actions">
        <label className="button primary icon-button" title="Upload a new PDF">
          <Upload size={16} />
          <input type="file" accept="application/pdf" onChange={onPdfUpload} />
        </label>
        <button className="icon-button" title="Create another crop template from the selected PDF" disabled={!canCreateFromActivePdf} onClick={onCreateTemplateFromActivePdf}>
          <Plus size={16} />
        </button>
        <label className="button icon-button" title="Upload CSV dataset">
          <Table size={16} />
          <input type="file" accept=".csv,text/csv" onChange={onCsvUpload} />
        </label>
      </div>
    </div>
  );
}

function ContextSummary({ template, dataset, setView }) {
  return (
    <div className="context-summary">
      <button onClick={() => setView("mapping")} title="Change template in Print Job">
        <span>Template</span>
        <strong>{template?.templateName ?? "None"}</strong>
      </button>
      <button onClick={() => setView("mapping")} title="Change CSV in Print Job">
        <span>CSV</span>
        <strong>{dataset?.name ?? "None"}</strong>
      </button>
    </div>
  );
}

function LibraryPanel(props) {
  const {
    templates,
    activeTemplateId,
    setActiveTemplateId,
    csvDatasets,
    activeCsvId,
    setActiveCsvId,
    onPdfUpload,
    onCreateTemplateFromActivePdf,
    canCreateFromActivePdf,
    onCsvUpload,
  } = props;
  return (
    <div className="library-panel">
      <div className="quick-actions">
        <label className="button primary icon-button" title="Upload a new PDF">
          <Upload size={16} />
          <input type="file" accept="application/pdf" onChange={onPdfUpload} />
        </label>
        <button className="icon-button" title="Create another crop template from the selected PDF" disabled={!canCreateFromActivePdf} onClick={onCreateTemplateFromActivePdf}>
          <Plus size={16} />
        </button>
        <label className="button icon-button" title="Upload CSV dataset">
          <Table size={16} />
          <input type="file" accept=".csv,text/csv" onChange={onCsvUpload} />
        </label>
      </div>
      <label className="library-select">
        <span>Active template</span>
        <select value={activeTemplateId} onChange={(event) => setActiveTemplateId(event.target.value)}>
          {templates.length === 0 && <option value="">No templates</option>}
          {templates.map((template) => (
            <option key={template.templateId} value={template.templateId}>
              {template.templateName} · {template.variables.length} vars
            </option>
          ))}
        </select>
      </label>
      <label className="library-select">
        <span>Active CSV</span>
        <select value={activeCsvId} onChange={(event) => setActiveCsvId(event.target.value)}>
          {csvDatasets.length === 0 && <option value="">No CSV dataset</option>}
          {csvDatasets.map((dataset) => (
            <option key={dataset.id} value={dataset.id}>
              {dataset.name} · {dataset.rows.length} rows
            </option>
          ))}
        </select>
      </label>
      <div className="library-summary">
        <strong>{templates.find((template) => template.templateId === activeTemplateId)?.templateName ?? "No template"}</strong>
        <span>{templates.length} templates · {csvDatasets.length} CSV datasets</span>
      </div>
    </div>
  );
}

function HeaderSelectors({ templates, activeTemplateId, setActiveTemplateId, csvDatasets, activeCsvId, setActiveCsvId }) {
  return (
    <div className="header-selectors">
      <label>
        <span>Template</span>
        <select value={activeTemplateId} onChange={(event) => setActiveTemplateId(event.target.value)}>
          {templates.length === 0 && <option value="">No template</option>}
          {templates.map((template) => (
            <option key={template.templateId} value={template.templateId}>
              {template.templateName}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>CSV</span>
        <select value={activeCsvId} onChange={(event) => setActiveCsvId(event.target.value)}>
          {csvDatasets.length === 0 && <option value="">No CSV</option>}
          {csvDatasets.map((dataset) => (
            <option key={dataset.id} value={dataset.id}>
              {dataset.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function FlowBar({ view, setView, flowStatus, t }) {
  return (
    <div className="flow-bar">
      {FLOW.map((step, index) => {
        const state = flowStatus[step.id] ?? "waiting";
        return (
          <button key={step.id} className={`${view === step.id ? "active" : ""} ${state}`} onClick={() => setView(step.id)}>
            <span className="flow-index">{index + 1}</span>
            {t(step.labelKey)}
          </button>
        );
      })}
    </div>
  );
}

function TemplatesPage({
  templates,
  activeTemplateId,
  setActiveTemplateId,
  updateTemplate,
  onPdfUpload,
  onCreateTemplateFromActivePdf,
  canCreateFromActivePdf,
  openDesignerForTemplate,
  removeCrop,
  deleteTemplate,
  t,
}) {
  return (
    <section className="page-grid">
      <div className="section-card span-2">
        <div className="section-head">
          <div>
            <h3>{t("page.templates.title")}</h3>
            <p className="muted">{t("templates.savedLocalText")}</p>
          </div>
          <label className="button primary">
            <Plus size={16} /> {t("button.uploadPdf")}
            <input type="file" accept="application/pdf" onChange={onPdfUpload} />
          </label>
          <button disabled={!canCreateFromActivePdf} onClick={onCreateTemplateFromActivePdf}>
            <Plus size={16} /> {t("button.newCrop")}
          </button>
        </div>
        <div className="template-list">
          {templates.length === 0 && <EmptyState title={t("source.noTemplates")} text={t("source.noTemplatesText")} />}
          {templates.map((template) => (
            <article key={template.templateId} className={`template-row ${template.templateId === activeTemplateId ? "active" : ""}`}>
              <button className="template-row-main" onClick={() => setActiveTemplateId(template.templateId)}>
                <span>{template.sourcePdf.fileName}</span>
                <span>
                  {t("source.page")} {template.sourcePdf.pageNumber ?? 1} · {template.cropArea ? t("source.cropSaved") : t("source.needsCrop")} · {template.variables.length} {t("source.variables")}
                </span>
              </button>
              <input
                className="template-name-input"
                value={template.templateName}
                onChange={(event) => updateTemplate(template.templateId, { templateName: event.target.value })}
              />
              <div className="template-row-actions">
                <button
                  aria-label={template.cropArea ? t("source.editDesign") : t("source.designCrop")}
                  title={template.cropArea ? t("source.editDesign") : t("source.designCrop")}
                  onClick={() => openDesignerForTemplate(template.templateId, template.cropArea ? "fields" : "crop")}
                >
                  <MousePointer2 size={16} /> {template.cropArea ? t("source.editDesign") : t("source.designCrop")}
                </button>
                <button
                  aria-label={t("source.showCrop")}
                  title={t("source.showCrop")}
                  disabled={!template.cropArea}
                  onClick={() => openDesignerForTemplate(template.templateId, "fields")}
                >
                  <Eye size={16} /> {t("source.showCrop")}
                </button>
                <button
                  aria-label={t("source.removeCrop")}
                  className="danger"
                  title={t("source.removeCrop")}
                  disabled={!template.cropArea}
                  onClick={() => removeCrop(template.templateId)}
                >
                  <X size={16} /> {t("source.removeCrop")}
                </button>
                <button
                  aria-label={t("button.deleteTemplate")}
                  className="danger"
                  title={t("button.deleteTemplate")}
                  onClick={() => deleteTemplate(template.templateId)}
                >
                  <Trash2 size={16} /> {t("button.deleteTemplate")}
                </button>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function DesignerPage(props) {
  const {
    templates,
    activeTemplateId,
    setActiveTemplateId,
    template,
    designerMode,
    setDesignerMode,
    canvasRef,
    overlayRef,
    renderBox,
    cropRect,
    cropDebug,
    pdfZoom,
    setPdfZoom,
    pageNumber,
    pageCount,
    setPageNumber,
    beginCropCreate,
    beginCropDrag,
    saveCrop,
    clearCrop,
    onPdfUpload,
    cropPreviewRef,
    selectedVariableId,
    setSelectedVariableId,
    selectedVariable,
    beginVariableDrag,
    addVariable,
    duplicateVariable,
    deleteVariable,
    updateVariable,
    updateVariableStyle,
    cropPreviewImageUrl,
    cropPreviewDisplaySize,
    t,
  } = props;
  const [inspectorOpen, setInspectorOpen] = useState(true);
  if (!template) return <EmptyUpload onPdfUpload={onPdfUpload} t={t} />;
  const showCropMode = designerMode === "crop" || !template.cropArea;
  const addField = () => {
    setInspectorOpen(true);
    addVariable();
  };
  return (
    <section className={showCropMode ? "crop-layout" : `editor-layout ${inspectorOpen ? "" : "panel-closed"}`}>
      <div className="canvas-card">
        <div className="local-toolbar">
          <label className="designer-template-select">
            <span>{t("common.template")}</span>
            <select value={activeTemplateId} onChange={(event) => setActiveTemplateId(event.target.value)}>
              {templates.map((item) => (
                <option key={item.templateId} value={item.templateId}>{item.templateName}</option>
              ))}
            </select>
          </label>
          <div className="segmented">
            <button className={showCropMode ? "active" : ""} onClick={() => setDesignerMode("crop")}>{t("designer.crop")}</button>
            <button className={!showCropMode ? "active" : ""} disabled={!template.cropArea} onClick={() => setDesignerMode("fields")}>{t("designer.fields")}</button>
          </div>
          {showCropMode ? (
            <>
              <button disabled={pageNumber <= 1} onClick={() => setPageNumber((p) => p - 1)}><ChevronLeft size={16} /> {t("designer.previous")}</button>
              <button disabled={pageNumber >= pageCount} onClick={() => setPageNumber((p) => p + 1)}>{t("designer.next")} <ChevronRight size={16} /></button>
              <span className="meta">{t("source.page")} {pageNumber} / {pageCount || "-"}</span>
              <div className="zoom-controls" aria-label={t("designer.pdfZoomAria")}>
                <button onClick={() => setPdfZoom((zoom) => Math.max(0.5, Number((zoom - 0.25).toFixed(2))))}>-</button>
                <span>{Math.round(pdfZoom * 100)}%</span>
                <button onClick={() => setPdfZoom((zoom) => Math.min(2.5, Number((zoom + 0.25).toFixed(2))))}>+</button>
              </div>
              <button onClick={clearCrop}>{t("designer.redrawCrop")}</button>
              <button className="primary" disabled={!cropRect} onClick={saveCrop}><Save size={16} /> {t("designer.saveCrop")}</button>
              <span className="toolbar-hint">{t("designer.cropHint")}</span>
              <DebugInline cropDebug={cropDebug} renderBox={renderBox} />
            </>
          ) : (
            <>
              <button className="primary" onClick={addField}><Plus size={16} /> {t("designer.addField")}</button>
              <span className="meta">{t("designer.savedFields", { count: template.variables.length })}</span>
              {!inspectorOpen && <button onClick={() => setInspectorOpen(true)}><ListChecks size={16} /> {t("designer.fieldsPanel")}</button>}
            </>
          )}
        </div>
        {showCropMode ? (
          <div className="pdf-frame" style={{ width: renderBox.width || "auto" }}>
            <canvas ref={canvasRef} />
            <div
              ref={overlayRef}
              className="overlay"
              style={{ width: renderBox.width, height: renderBox.height }}
              onPointerDown={beginCropCreate}
            >
              {cropRect && <CropBox rect={cropRect} onDrag={beginCropDrag} />}
            </div>
          </div>
        ) : (
          <TemplateCanvas
            template={template}
            cropPreviewRef={cropPreviewRef}
            selectedVariableId={selectedVariableId}
            setSelectedVariableId={setSelectedVariableId}
            beginVariableDrag={beginVariableDrag}
            cropImageUrl={cropPreviewImageUrl}
            cropPreviewDisplaySize={cropPreviewDisplaySize}
          />
        )}
      </div>
      {!showCropMode && inspectorOpen && (
        <aside className="inspector">
          <div className="panel-head">
            <div>
              <h3>{t("designer.fields")}</h3>
              <p className="muted">{t("designer.fieldsCount", { count: template.variables.length })}</p>
            </div>
            <button className="icon-button" title={t("designer.closeFieldsPanel")} onClick={() => setInspectorOpen(false)}><X size={16} /></button>
          </div>
          <div className="variable-list">
            {template.variables.length === 0 && <p className="muted">{t("designer.noFields")}</p>}
            {template.variables.map((variable) => (
              <div key={variable.id} className={`variable-list-row ${variable.id === selectedVariableId ? "selected" : ""}`}>
                <button onClick={() => setSelectedVariableId(variable.id)}>
                  <strong>{variable.displayName}</strong>
                  <span>{variable.key}</span>
                </button>
                <div className="variable-list-actions">
                  <button className="icon-button" title={t("designer.duplicateField")} onClick={() => duplicateVariable(variable.id)}><Copy size={14} /></button>
                  <button className="icon-button danger" title={t("designer.deleteField")} onClick={() => deleteVariable(variable.id)}><X size={14} /></button>
                </div>
              </div>
            ))}
          </div>
          <VariableEditor
            variable={selectedVariable}
            updateVariable={updateVariable}
            updateVariableStyle={updateVariableStyle}
            duplicateVariable={() => duplicateVariable(selectedVariableId)}
            deleteVariable={deleteVariable}
            t={t}
          />
        </aside>
      )}
    </section>
  );
}

function CropBox({ rect, onDrag }) {
  return (
    <div className="crop-box" style={rectStyle(rect)} onPointerDown={(event) => onDrag(event, "move")}>
      <span className="handle nw" onPointerDown={(event) => onDrag(event, "nw")} />
      <span className="handle ne" onPointerDown={(event) => onDrag(event, "ne")} />
      <span className="handle sw" onPointerDown={(event) => onDrag(event, "sw")} />
      <span className="handle se" onPointerDown={(event) => onDrag(event, "se")} />
    </div>
  );
}

function TemplateCanvas({
  template,
  cropPreviewRef,
  selectedVariableId,
  setSelectedVariableId,
  beginVariableDrag,
  previewValues = {},
  cropImageUrl = "",
  cropPreviewDisplaySize = null,
}) {
  const editable = Boolean(beginVariableDrag);
  const previewStyle = cropPreviewDisplaySize
    ? { width: `${cropPreviewDisplaySize.width}px`, height: `${cropPreviewDisplaySize.height}px` }
    : undefined;
  const cropSize = getCropPointSize(template);
  const previewFontScale = cropSize && cropPreviewDisplaySize?.width
    ? cropPreviewDisplaySize.width / cropSize.width
    : 0.72;
  if (!editable) {
    return (
      <div className="crop-preview" ref={cropPreviewRef} style={previewStyle}>
        <PaperTemplateSlot
          template={template}
          cropImageUrl={cropImageUrl}
          previewValues={previewValues}
          style={{ width: "100%", height: "100%" }}
          fontScale={previewFontScale}
        />
      </div>
    );
  }
  return (
    <div className="crop-preview" ref={cropPreviewRef} style={previewStyle}>
      {cropImageUrl ? <img className="crop-preview-image" src={cropImageUrl} alt="" /> : <canvas />}
      <div className="variable-layer">
        {template.variables.map((variable) => (
          <div
            key={variable.id}
            className={`variable-box ${selectedVariableId === variable.id ? "selected" : ""}`}
            style={{
              left: `${variable.xRatio * 100}%`,
              top: `${variable.yRatio * 100}%`,
              width: `${variable.widthRatio * 100}%`,
              height: `${variable.heightRatio * 100}%`,
              color: variable.style.color,
              backgroundColor: variable.style.backgroundColor || "rgba(255, 255, 255, 0.42)",
              fontSize: Math.max(5, variable.style.fontSize * previewFontScale),
              fontWeight: variable.style.fontWeight,
              justifyContent: justify(variable.style.textAlign),
              alignItems: align(variable.style.verticalAlign),
              textAlign: variable.style.textAlign,
            }}
            onPointerDown={(event) => editable && beginVariableDrag(event, variable.id, "move")}
            onClick={() => editable && setSelectedVariableId(variable.id)}
          >
            {previewValues[variable.id] ?? variable.displayName}
            {editable && <span className="handle se" onPointerDown={(event) => beginVariableDrag(event, variable.id, "se")} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function VariableEditor({ variable, updateVariable, updateVariableStyle, duplicateVariable, deleteVariable, t }) {
  if (!variable) return <p className="muted">{t("designer.selectVariableToEdit")}</p>;
  const isBackgroundTransparent = !variable.style.backgroundColor || variable.style.backgroundColor === "transparent";
  return (
    <div className="field-editor">
      <div className="form-stack">
        <label>{t("field.key")}<input value={variable.key} onChange={(event) => updateVariable({ key: event.target.value })} /></label>
        <label>{t("field.displayName")}<input value={variable.displayName} onChange={(event) => updateVariable({ displayName: event.target.value })} /></label>
      </div>
      <div className="form-grid compact-form">
        <label>{t("field.fontSize")}<input type="number" min="4" value={variable.style.fontSize} onChange={(event) => updateVariableStyle({ fontSize: Number(event.target.value) })} /></label>
        <label>{t("field.weight")}<select value={variable.style.fontWeight} onChange={(event) => updateVariableStyle({ fontWeight: event.target.value })}><option value="normal">{t("field.weight.normal")}</option><option value="bold">{t("field.weight.bold")}</option></select></label>
        <label>{t("field.textAlign")}<select value={variable.style.textAlign} onChange={(event) => updateVariableStyle({ textAlign: event.target.value })}><option value="left">{t("field.align.left")}</option><option value="center">{t("field.align.center")}</option><option value="right">{t("field.align.right")}</option></select></label>
        <label>{t("field.verticalAlign")}<select value={variable.style.verticalAlign} onChange={(event) => updateVariableStyle({ verticalAlign: event.target.value })}><option value="top">{t("field.vertical.top")}</option><option value="middle">{t("field.vertical.middle")}</option><option value="bottom">{t("field.vertical.bottom")}</option></select></label>
      </div>
      <div className="swatch-row">
        <label>{t("field.textColor")}<input type="color" value={variable.style.color} onChange={(event) => updateVariableStyle({ color: event.target.value })} /></label>
        <div className="bg-color-control">
          <span>{t("field.boxBackground")}</span>
          <div className="bg-color-row">
            <input
              type="color"
              value={normalizeColor(variable.style.backgroundColor)}
              disabled={isBackgroundTransparent}
              onChange={(event) => updateVariableStyle({ backgroundColor: event.target.value })}
            />
            <label className="bg-transparent-toggle">
              <input
                type="checkbox"
                checked={isBackgroundTransparent}
                onChange={(event) =>
                  updateVariableStyle({
                    backgroundColor: event.target.checked
                      ? "transparent"
                      : normalizeColor(variable.style.backgroundColor),
                  })
                }
              />
              <span>{t("field.noColor")}</span>
            </label>
          </div>
        </div>
      </div>
      <label className="check"><input type="checkbox" checked={variable.style.autoFit} onChange={(event) => updateVariableStyle({ autoFit: event.target.checked })} /> {t("field.autoFit")}</label>
      <div className="field-editor-actions">
        <button onClick={duplicateVariable} title={t("button.duplicate")} aria-label={t("button.duplicate")}>
          <Copy size={16} /> <span className="action-label">{t("button.duplicate")}</span>
        </button>
        <button className="danger" onClick={() => deleteVariable(variable.id)} title={t("button.delete")} aria-label={t("button.delete")}>
          <Trash2 size={16} /> <span className="action-label">{t("button.delete")}</span>
        </button>
      </div>
    </div>
  );
}

function CsvPage({
  datasets,
  activeCsvId,
  setActiveCsvId,
  previewCsvId,
  setPreviewCsvId,
  onCsvUpload,
  deleteCsvDataset,
  t,
}) {
  const active = datasets.find((dataset) => dataset.id === activeCsvId);
  const previewDataset = datasets.find((dataset) => dataset.id === previewCsvId);
  return (
    <section className={previewCsvId ? "page-grid" : "page-grid single-column"}>
      <div className="section-card">
        <div className="section-head">
          <div>
            <h3>{t("csv.savedDatasets")}</h3>
            <p className="muted">{t("csv.savedDatasetsText")}</p>
          </div>
          <div className="csv-upload-tools">
            <label className="button primary">
              <Upload size={16} /> {t("button.uploadCsv")}
              <input type="file" accept=".csv,text/csv" onChange={onCsvUpload} />
            </label>
          </div>
        </div>
        <div className="csv-list">
          {datasets.length === 0 && <EmptyState title={t("csv.noDatasets")} text={t("csv.noDatasetsText")} />}
          {datasets.map((dataset) => (
            <article key={dataset.id} className={`csv-row ${dataset.id === activeCsvId ? "active" : ""}`}>
              <button className="csv-row-main" onClick={() => setActiveCsvId(dataset.id)}>
                <strong>{dataset.name}</strong>
                <span>
                  {dataset.fileName} · {dataset.rows.length} rows · {dataset.headers.length} columns · {encodingLabel(dataset.encoding)}
                  {dataset.encodingDetected ? ` ${t("csv.autoDetected")}` : ""}
                </span>
              </button>
              <div className="csv-row-actions">
                <button className="preview-button" onClick={() => setPreviewCsvId(previewCsvId === dataset.id ? "" : dataset.id)}>
                  <Eye size={16} />
                  {previewCsvId === dataset.id ? t("button.close") : t("button.preview")}
                </button>
                <button className="danger" onClick={() => deleteCsvDataset(dataset.id)}>
                  <Trash2 size={16} /> {t("button.deleteCsv")}
                </button>
              </div>
            </article>
          ))}
        </div>
      </div>
      {previewCsvId ? (
        <div className="section-card">
          <div className="panel-head">
            <div>
              <h3>{t("preview.csv")}</h3>
              <p className="muted">{previewDataset?.name}</p>
            </div>
            <button className="icon-button" title={t("preview.closeCsv")} onClick={() => setPreviewCsvId("")}><X size={16} /></button>
          </div>
          <CsvPreview dataset={previewDataset} t={t} />
        </div>
      ) : null}
    </section>
  );
}
function CsvPreview({ dataset, t }) {
  if (!dataset) return <EmptyState title={t("csv.selectForPreview")} text={t("csv.previewDescription")} />;
  return (
    <div className="table-wrap">
      <h3>{dataset.name}</h3>
      <p className="muted">{dataset.fileName} · {encodingLabel(dataset.encoding)} · {t("csv.rows", { count: dataset.rows.length })}</p>
      <table>
        <thead><tr>{dataset.headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
        <tbody>{dataset.rows.slice(0, 8).map((row, index) => <tr key={index}>{dataset.headers.map((header) => <td key={header}>{row[header]}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function MappingPage({
  template,
  dataset,
  mapping,
  updateMapping,
  templates,
  activeTemplateId,
  setActiveTemplateId,
  csvDatasets,
  activeCsvId,
  setActiveCsvId,
  cropPreviewRef,
  previewOpen,
  setPreviewOpen,
  cropPreviewImageUrl,
  cropPreviewDisplaySize,
  t,
}) {
  const [selectedDropVariableId, setSelectedDropVariableId] = useState("");
  const previewValues = useMemo(() => previewValuesFromRow(template, dataset, mapping, dataset?.rows?.[0]), [template, dataset, mapping]);
  const mappedHeaders = new Set(Object.values(mapping).filter(Boolean));
  const mappingFunctions = useMemo(
    () => MAPPING_FUNCTIONS.map((item) => ({ ...item, label: t(item.labelKey), sample: resolveMappedValue(item.key, {}) })),
    [t],
  );
  const assignHeader = (variableId, header) => {
    if (!variableId || !header) return;
    updateMapping(variableId, header);
    setSelectedDropVariableId("");
  };
  const firstUnmappedVariable = template?.variables.find((variable) => !mapping[variable.id]);
  const clickHeader = (header) => assignHeader(selectedDropVariableId || firstUnmappedVariable?.id, header);
  return (
    <section className={previewOpen ? "page-grid print-page-grid" : "page-grid single-column"}>
      <div className="section-card">
        <div className="section-head mapping-section-head">
          <div>
            <h3>{t("mapping.title")}</h3>
            <p className="muted">{t("mapping.description")}</p>
          </div>
          <button
            className="preview-button mapping-preview-button"
            disabled={!template?.cropArea || !dataset}
            onClick={() => setPreviewOpen(true)}
            aria-label={t("button.preview")}
            title={t("button.preview")}
          >
            <Eye size={16} /> <span className="preview-text">{t("button.preview")}</span>
          </button>
        </div>
        <div className="print-job-picker mapping-picker">
          <label>
            <span>{t("mapping.template")}</span>
            <select value={activeTemplateId} onChange={(event) => setActiveTemplateId(event.target.value)}>
              {templates.length === 0 && <option value="">{t("mapping.noTemplates")}</option>}
              {templates.map((item) => (
                <option key={item.templateId} value={item.templateId}>
                  {item.templateName} - {item.variables.length} vars
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("mapping.csvDataset")}</span>
            <select value={activeCsvId} onChange={(event) => setActiveCsvId(event.target.value)}>
              {csvDatasets.length === 0 && <option value="">{t("mapping.noCsvDatasets")}</option>}
              {csvDatasets.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} - {item.rows.length} rows
                </option>
              ))}
            </select>
          </label>
        </div>
        {!template && <EmptyState title={t("mapping.noTemplateSelected")} text={t("mapping.noTemplateText")} />}
        {template && !dataset && <EmptyState title={t("mapping.noCsvSelected")} text={t("mapping.noCsvText")} />}
        {template && dataset && (
          <div className="mapping-workspace">
            <div className="mapping-panel">
              <div className="mapping-panel-head">
                <h3>{t("mapping.templateFields")}</h3>
                <span>{template.variables.filter((variable) => mapping[variable.id]).length} / {template.variables.length}</span>
              </div>
              <div className="mapping-drop-list">
                {template.variables.length === 0 && <EmptyState title={t("mapping.noVariables")} text={t("mapping.noVariablesText")} />}
                {template.variables.map((variable) => {
                  const source = mapping[variable.id] ?? "";
                  return (
                    <button
                      key={variable.id}
                      className={`mapping-drop-row ${selectedDropVariableId === variable.id ? "selected" : ""} ${source ? "mapped" : ""}`}
                      onClick={() => setSelectedDropVariableId(variable.id)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => assignHeader(variable.id, event.dataTransfer.getData("text/plain"))}
                    >
                      <span className="mapping-var-name">
                        <strong>{variable.displayName}</strong>
                        <small>{variable.key}</small>
                      </span>
                      <span className="mapping-target">
                        {source ? (
                          <>
                            <strong>{mappingSourceLabel(source, t)}</strong>
                            <small>{sampleValue(dataset, source)}</small>
                          </>
                        ) : (
                          <em>{t("mapping.dropCsvField")}</em>
                        )}
                      </span>
                      {source && (
                        <span
                          role="button"
                          tabIndex={0}
                          className="mapping-clear"
                          onClick={(event) => {
                            event.stopPropagation();
                            updateMapping(variable.id, "");
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") updateMapping(variable.id, "");
                          }}
                        >
                          <X size={14} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="mapping-panel">
              <div className="mapping-panel-head">
                <h3>{t("mapping.csvFields")}</h3>
                <span>{dataset.headers.length}</span>
              </div>
              <div className="csv-field-list">
                {dataset.headers.map((header) => (
                  <button
                    key={header}
                    className={`csv-field-chip ${mappedHeaders.has(header) ? "used" : ""}`}
                    draggable
                    onDragStart={(event) => event.dataTransfer.setData("text/plain", header)}
                    onClick={() => clickHeader(header)}
                  >
                    <strong>{header}</strong>
                    <small>{sampleValue(dataset, header)}</small>
                  </button>
                ))}
                <div className="mapping-functions-head">{t("mapping.functions")}</div>
                {mappingFunctions.map((fn) => (
                  <button
                    key={fn.key}
                    className={`csv-field-chip mapping-function-chip ${mappedHeaders.has(fn.key) ? "used" : ""}`}
                    draggable
                    onDragStart={(event) => event.dataTransfer.setData("text/plain", fn.key)}
                    onClick={() => clickHeader(fn.key)}
                  >
                    <strong>{fn.label}</strong>
                    <small>{fn.sample}</small>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
      {template?.cropArea && previewOpen ? (
        <PreviewCard
          template={template}
          cropPreviewRef={cropPreviewRef}
          onClose={() => setPreviewOpen(false)}
          previewValues={previewValues}
          cropImageUrl={cropPreviewImageUrl}
          cropPreviewDisplaySize={cropPreviewDisplaySize}
          t={t}
        />
      ) : !template?.cropArea && previewOpen ? (
        <div className="section-card quiet-card">
          <MousePointer2 size={30} />
          <h3>{t("preview.template")}</h3>
          <p className="muted">{t("preview.saveCropHint")}</p>
        </div>
      ) : null}
    </section>
  );
}

function LayoutPage({
  template,
  dataset,
  mapping,
  selectedRowIds,
  setSelectedRowIds,
  rowCopies,
  setRowCopies,
  cropPreviewRef,
  layout,
  setLayout,
  autoLayout,
  generatePdf,
  openPdfForPrint,
  exportUrl,
  isGeneratingPdf,
  previewOpen,
  setPreviewOpen,
  cropPreviewImageUrl,
  setView,
  pageSize,
  t,
}) {
  const update = (key, value) => setLayout((current) => ({ ...current, [key]: value }));
  const [splitPercent, setSplitPercent] = useState(36);
  const splitGridRef = useRef(null);
  const selectedCount = dataset ? selectedRowIds.filter((id) => Number(id) < dataset.rows.length).length : 0;
  const totalRows = dataset?.rows.length ?? 0;
  const allRowsSelected = totalRows > 0 && selectedCount >= totalRows;
  const printableRows = useMemo(() => getPrintableRowEntries(dataset, selectedRowIds), [dataset, selectedRowIds]);
  const applyPreset = (preset) => setLayout((current) => ({ ...current, ...preset }));
  const updatePair = (xKey, yKey, value) => setLayout((current) => ({ ...current, [xKey]: value, [yKey]: value }));
  const cropSize = getCropPointSize(template, pageSize);
  const printedSize = cropSize ? getPrintedTemplateSize(layout, cropSize) : null;
  const startSplitDrag = (event) => {
    if (!splitGridRef.current || window.innerWidth <= 1080) return;
    event.preventDefault();
    const bounds = splitGridRef.current.getBoundingClientRect();
    const onMove = (moveEvent) => {
      const raw = ((moveEvent.clientX - bounds.left) / bounds.width) * 100;
      setSplitPercent(clampNumber(raw, 36, 88));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  return (
    <section
      ref={splitGridRef}
      className={previewOpen ? "page-grid print-page-grid layout-split-grid" : "page-grid single-column"}
      style={previewOpen ? { "--layout-left-width": `${splitPercent}%` } : undefined}
    >
      <div className="section-card layout-section-card">
        <div className="section-head layout-section-head">
          <div>
            <h3>{t("layout.chooseWhatToPrint")}</h3>
            <p className="muted">{t("layout.chooseWhatToPrintText")}</p>
          </div>
          <button
            className="preview-button layout-preview-button"
            onClick={() => setPreviewOpen(true)}
            aria-label={t("button.previewPrintSheet")}
            title={t("button.previewPrintSheet")}
          >
            <Eye size={16} /> <span className="preview-text">{t("button.previewPrintSheet")}</span>
          </button>
        </div>
        <div className="print-job-summary">
          <div>
            <span>{t("print.jobSummary")}</span>
            <strong>{template?.templateName ?? t("common.noTemplate")} + {dataset?.name ?? t("common.noCsv")}</strong>
          </div>
          <button onClick={() => setView("mapping")}><Database size={16} /> {t("button.changePrintJob")}</button>
        </div>
        <div className="section-head subtle-head">
          <div>
            <h3>{t("print.records")}</h3>
            <p className="muted">{t("print.recordsSelectedSummary", { selected: selectedCount, total: dataset?.rows.length ?? 0 })}</p>
          </div>
          <button
            onClick={() => {
              if (!dataset) return;
              if (allRowsSelected) {
                setSelectedRowIds([]);
                return;
              }
              setSelectedRowIds(dataset.rows.map((_, index) => String(index)));
            }}
            title={allRowsSelected ? t("button.unselectAll") : t("button.selectAll")}
          >
            <Rows3 size={16} /> {allRowsSelected ? t("button.unselectAll") : t("button.selectAll")}
          </button>
        </div>
        <CsvRowPicker dataset={dataset} selectedRowIds={selectedRowIds} setSelectedRowIds={setSelectedRowIds} rowCopies={rowCopies} setRowCopies={setRowCopies} t={t} />
        <div className="print-flow">
          <div className="choice-group">
            <h3>{t("print.paper")}</h3>
            <div className="choice-row">
              {["A4", "A3"].map((paper) => <button key={paper} className={layout.paperSize === paper ? "active" : ""} onClick={() => update("paperSize", paper)}>{paper}</button>)}
              {["portrait", "landscape"].map((orientation) => <button key={orientation} className={layout.orientation === orientation ? "active" : ""} onClick={() => update("orientation", orientation)}>{t(`print.orientation.${orientation}`)}</button>)}
            </div>
          </div>
          <div className="choice-group">
            <h3>{t("print.layoutPreset")}</h3>
            <div className="preset-grid">
              <button onClick={autoLayout}><Grid2X2 size={16} /> {t("button.bestFit")}</button>
              <button onClick={() => applyPreset({ rows: 1, columns: 1 })}>{t("button.onePerPage")}</button>
              <button onClick={() => applyPreset({ rows: 2, columns: 1 })}>{t("button.twoPerPage")}</button>
              <button onClick={() => applyPreset({ rows: 2, columns: 2 })}>{t("button.fourPerPage")}</button>
              <button onClick={() => applyPreset({ rows: 4, columns: 2 })}>{t("button.eightPerPage")}</button>
            </div>
          </div>
          <div className="choice-group">
            <h3>{t("print.printSize")}</h3>
            <div className="choice-row">
              <button className={layout.sizeMode === "actual" ? "active" : ""} onClick={() => update("sizeMode", "actual")}>{t("print.actualSize")}</button>
              <button className={layout.sizeMode !== "actual" ? "active" : ""} onClick={() => update("sizeMode", "fit")}>{t("print.resizeToFit")}</button>
            </div>
            {cropSize && (
              <p className="muted">
                {t("print.actualCropSize")}: {pointsToCm(cropSize.width)} x {pointsToCm(cropSize.height)} cm
                {printedSize && ` · ${t("print.printedSize")}: ${pointsToCm(printedSize.width)} x ${pointsToCm(printedSize.height)} cm`}
              </p>
            )}
          </div>
          <details className="advanced-layout">
            <summary><SlidersHorizontal size={16} /> {t("print.fineTune")}</summary>
            <div className="human-controls">
              <Stepper label={t("print.itemsAcross")} value={layout.columns} min={1} max={8} onChange={(value) => update("columns", value)} />
              <Stepper label={t("print.itemsDown")} value={layout.rows} min={1} max={12} onChange={(value) => update("rows", value)} />
              <RangeControl label={t("print.edgeSpace")} value={layout.marginX} min={0} max={80} onChange={(value) => updatePair("marginX", "marginY", value)} />
              <RangeControl label={t("print.itemSpace")} value={layout.gapX} min={0} max={60} onChange={(value) => updatePair("gapX", "gapY", value)} />
            </div>
          </details>
          <div className="print-actions">
            <button className="primary" disabled={isGeneratingPdf} onClick={() => generatePdf({ downloadAfter: true }).catch((error) => window.alert(error.message))}>
              {isGeneratingPdf ? <span className="spinner" aria-hidden="true" /> : <ArrowDownToLine size={16} />}
              {isGeneratingPdf ? t("status.generatingPdf") : t("button.generatePdf")}
            </button>
            <button disabled={isGeneratingPdf} onClick={openPdfForPrint}>
              {isGeneratingPdf ? <span className="spinner" aria-hidden="true" /> : <FileText size={16} />}
              {isGeneratingPdf ? t("status.generatingPdf") : t("button.openPdfToPrint")}
            </button>
          </div>
        </div>
      </div>
      {previewOpen ? (
        <div
          className="layout-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize print setup and preview panels"
          aria-valuemin={36}
          aria-valuemax={88}
          aria-valuenow={Math.round(splitPercent)}
          onMouseDown={startSplitDrag}
        >
          <span className="layout-splitter-handle" aria-hidden="true" />
        </div>
      ) : null}
      {previewOpen ? (
      <div className="section-card preview-card">
        <div className="panel-head">
          <div>
            <h3>{t("preview.print")}</h3>
            <p className="muted">{t("preview.printUpdatesHint")}</p>
          </div>
          <button className="icon-button" title={t("preview.closePrint")} onClick={() => setPreviewOpen(false)}><X size={16} /></button>
        </div>
        <PrintSheetPreview
          layout={layout}
          template={template}
          pageSize={pageSize}
          dataset={dataset}
          mapping={mapping}
          rows={printableRows}
          rowCopies={rowCopies}
          cropImageUrl={cropPreviewImageUrl}
          t={t}
        />
      </div>
      ) : null}
    </section>
  );
}

function CsvRowPicker({ dataset, selectedRowIds, setSelectedRowIds, rowCopies, setRowCopies, t }) {
  if (!dataset) return <EmptyState title={t("print.noCsvSelected")} text={t("print.noCsvSelectedText")} />;
  const toggle = (rowId) => {
    setSelectedRowIds((current) =>
      current.includes(rowId) ? current.filter((id) => id !== rowId) : [...current, rowId],
    );
  };
  return (
    <div className="row-picker">
      <table>
        <thead>
          <tr>
            <th>{t("table.print")}</th>
            <th>{t("table.copies")}</th>
            {dataset.headers.slice(0, 4).map((header) => <th key={header}>{header}</th>)}
          </tr>
        </thead>
        <tbody>
          {dataset.rows.map((row, index) => {
            const rowId = String(index);
            return (
              <tr key={rowId}>
                <td><input type="checkbox" checked={selectedRowIds.includes(rowId)} onChange={() => toggle(rowId)} /></td>
                <td>
                  <input
                    className="copies-input"
                    type="number"
                    min="1"
                    value={rowCopies[rowId] ?? 1}
                    onChange={(event) => setRowCopies((current) => ({ ...current, [rowId]: Math.max(1, Number(event.target.value) || 1) }))}
                  />
                </td>
                {dataset.headers.slice(0, 4).map((header) => <td key={header}>{row[header]}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Stepper({ label, value, min, max, onChange }) {
  const nextValue = (delta) => clampNumber(value + delta, min, max);
  return (
    <div className="control-tile">
      <span>{label}</span>
      <div className="stepper">
        <button onClick={() => onChange(nextValue(-1))}>-</button>
        <strong>{value}</strong>
        <button onClick={() => onChange(nextValue(1))}>+</button>
      </div>
    </div>
  );
}

function RangeControl({ label, value, min, max, onChange }) {
  return (
    <label className="control-tile">
      <span>{label}</span>
      <input type="range" value={value} min={min} max={max} onChange={(event) => onChange(Number(event.target.value))} />
      <strong>{value} pt</strong>
    </label>
  );
}

function PrintSheetPreview({ layout, template, dataset, mapping, rows, rowCopies, cropImageUrl, pageSize, t }) {
  const [previewPage, setPreviewPage] = useState(1);
  const [previewZoom, setPreviewZoom] = useState(() => (window.innerWidth > 900 ? 1.2 : 1));
  const selectedCount = rows.reduce((count, entry) => count + getRowCopyCount(rowCopies, entry.index), 0) || 1;
  const slots = Math.max(1, layout.rows * layout.columns);
  const pages = Math.max(1, Math.ceil(selectedCount / slots));
  useEffect(() => {
    setPreviewPage((current) => Math.min(current, pages));
  }, [pages]);
  const paper = orientedPaper(layout);
  const isDesktopPreview = window.innerWidth > 900;
  const basePreviewWidth = isDesktopPreview
    ? layout.orientation === "landscape"
      ? 760
      : 580
    : layout.orientation === "landscape"
      ? 560
      : 420;
  const maxPreviewWidth = Math.max(220, window.innerWidth - (isDesktopPreview ? 140 : 52));
  const zoomedWidth = basePreviewWidth * previewZoom;
  const previewWidth = Math.min(zoomedWidth, maxPreviewWidth);
  const previewHeight = previewWidth * (paper.height / paper.width);
  const scale = previewWidth / paper.width;
  const cropSize = getCropPointSize(template, pageSize);
  const slotWidth = (paper.width - layout.marginX * 2 - layout.gapX * Math.max(0, layout.columns - 1)) / layout.columns;
  const slotHeight = (paper.height - layout.marginY * 2 - layout.gapY * Math.max(0, layout.rows - 1)) / layout.rows;
  const templateScale = cropSize && layout.sizeMode === "actual" ? 1 : cropSize ? Math.min(slotWidth / cropSize.width, slotHeight / cropSize.height) : 1;
  const tileStyle = cropSize ? {
    width: `${cropSize.width * templateScale * scale}px`,
    height: `${cropSize.height * templateScale * scale}px`,
  } : {};
  const allPreviewRows = expandRowEntries(rows, rowCopies);
  const previewRows = allPreviewRows.slice((previewPage - 1) * slots, previewPage * slots);
  const style = {
    width: previewWidth,
    height: previewHeight,
    padding: `${layout.marginY * scale}px ${layout.marginX * scale}px`,
    gap: `${layout.gapY * scale}px ${layout.gapX * scale}px`,
    gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))`,
  };
  return (
    <div className="sheet-preview-wrap">
      <div className="preview-controls-row">
        <div className="preview-page-controls">
          <button disabled={previewPage <= 1} onClick={() => setPreviewPage((page) => Math.max(1, page - 1))}>
            <ChevronLeft size={16} /> {t("designer.previous")}
          </button>
          <span>{t("source.page")} {previewPage} / {pages}</span>
          <button disabled={previewPage >= pages} onClick={() => setPreviewPage((page) => Math.min(pages, page + 1))}>
            {t("designer.next")} <ChevronRight size={16} />
          </button>
        </div>
        <div className="preview-zoom-controls" aria-label="Preview zoom controls">
          <button type="button" onClick={() => setPreviewZoom((value) => Math.max(0.7, Number((value - 0.1).toFixed(2))))}>-</button>
          <span>{Math.round(previewZoom * 100)}%</span>
          <button type="button" onClick={() => setPreviewZoom((value) => Math.min(1.9, Number((value + 0.1).toFixed(2))))}>+</button>
        </div>
      </div>
      <div className="sheet-preview-scroll">
        <div className="sheet-preview" style={style}>
          {Array.from({ length: Math.min(slots, 24) }).map((_, index) => (
            <div key={index} className={`paper-slot ${previewRows[index] ? "filled" : ""}`}>
              {previewRows[index] && template?.cropArea && (
                <PaperTemplateSlot
                  template={template}
                  cropImageUrl={cropImageUrl}
                  previewValues={previewValuesFromRow(template, dataset, mapping, previewRows[index].row)}
                  style={tileStyle}
                  fontScale={templateScale * scale}
                />
              )}
            </div>
          ))}
        </div>
      </div>
      <p className="muted">{t("print.previewSummary", { paper: layout.paperSize, orientation: t(`print.orientation.${layout.orientation}`), rows: layout.rows, columns: layout.columns, pages })}</p>
    </div>
  );
}

function PaperTemplateSlot({ template, cropImageUrl, previewValues, style, fontScale = 1 }) {
  return (
    <div className="paper-template" style={style}>
      {cropImageUrl && <img src={cropImageUrl} alt="" />}
      <div className="variable-layer">
        {template.variables.map((variable) => (
          <div
            key={variable.id}
            className="paper-variable"
            style={{
              left: `${variable.xRatio * 100}%`,
              top: `${variable.yRatio * 100}%`,
              width: `${variable.widthRatio * 100}%`,
              height: `${variable.heightRatio * 100}%`,
              color: variable.style.color,
              backgroundColor: variable.style.backgroundColor || "transparent",
              fontSize: Math.max(5, variable.style.fontSize * fontScale),
              fontWeight: variable.style.fontWeight,
              justifyContent: justify(variable.style.textAlign),
              alignItems: align(variable.style.verticalAlign),
              textAlign: variable.style.textAlign,
            }}
          >
            {previewValues[variable.id] ?? variable.displayName}
          </div>
        ))}
      </div>
    </div>
  );
}

function ExportPage({ template, dataset, generatePdf, cropPreviewRef }) {
  return (
    <section className="page-grid">
      <div className="section-card export-panel">
        <ArrowDownToLine size={36} />
        <h3>Generate printable PDF</h3>
        <p className="muted">
          Template: {template?.templateName ?? "None"}<br />
          CSV: {dataset?.name ?? "-"}
        </p>
        <button className="primary" onClick={() => generatePdf({ downloadAfter: true })}>Generate PDF</button>
      </div>
      {template?.cropArea && <PreviewCard template={template} cropPreviewRef={cropPreviewRef} />}
    </section>
  );
}

function PreviewCard({
  template,
  cropPreviewRef,
  embedded = false,
  onClose,
  previewValues = {},
  cropImageUrl = "",
  cropPreviewDisplaySize = null,
  t = (key) => key,
}) {
  return (
    <aside className={embedded ? "preview-card embedded-preview" : "section-card preview-card"}>
      <div className="panel-head">
        <div>
          <h3>{t("preview.template")}</h3>
          <p className="muted">{template.templateName}</p>
        </div>
        {onClose && <button className="icon-button" title={t("preview.close")} onClick={onClose}><X size={16} /></button>}
      </div>
      <TemplateCanvas
        template={template}
        cropPreviewRef={cropPreviewRef}
        selectedVariableId=""
        setSelectedVariableId={() => {}}
        previewValues={previewValues}
        cropImageUrl={cropImageUrl}
        cropPreviewDisplaySize={cropPreviewDisplaySize}
      />
    </aside>
  );
}

function PreviewPlaceholder({ title, text, onPreview }) {
  return (
    <div className="section-card quiet-card">
      <Eye size={30} />
      <h3>{title}</h3>
      <p className="muted">{text}</p>
      <button onClick={onPreview}><Eye size={16} /> Preview</button>
    </div>
  );
}

function EmptyUpload({ onPdfUpload, t }) {
  return (
    <div className="empty-state large">
      <FileText size={42} />
      <h3>{t("empty.startWithPdf")}</h3>
      <p>{t("empty.startWithPdfText")}</p>
      <label className="button primary">
        <Upload size={18} /> {t("button.uploadPdf")}
        <input type="file" accept="application/pdf" onChange={onPdfUpload} />
      </label>
    </div>
  );
}

function EmptyState({ title, text }) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

function DebugPanel({ cropDebug, renderBox }) {
  return (
    <div className="debug">
      <h3>Coordinate debug</h3>
      <p>Render scale: {renderBox.scale.toFixed(3)}</p>
      {cropDebug ? (
        <>
          <code>screen {fmtRect(cropDebug.screen)}</code>
          <code>ratio {fmtRatio(cropDebug.ratios)}</code>
          <code>pdf {fmtRect(cropDebug.pdf)}</code>
        </>
      ) : <p className="muted">Draw a crop box to inspect coordinates.</p>}
    </div>
  );
}

function DebugInline({ cropDebug, renderBox }) {
  return (
    <span className="debug-inline">
      Scale {renderBox.scale.toFixed(3)}
      {cropDebug && ` · ${fmtRatio(cropDebug.ratios)}`}
    </span>
  );
}

function autoMapping(variables, headers, existing = {}) {
  const next = { ...existing };
  variables.forEach((variable) => {
    if (!next[variable.id]) next[variable.id] = headers.find((header) => header === variable.key) ?? headers[0] ?? "";
  });
  return next;
}

function mappingKey(templateId, csvId) {
  return `${templateId}::${csvId}`;
}

function getFlowStatus(template, dataset, mapping, selectedRowIds) {
  const mappedCount = template?.variables.filter((variable) => mapping?.[variable.id]).length ?? 0;
  return {
    setup: template && dataset ? "done" : template || dataset ? "warning" : "waiting",
    templateLibrary: template ? "done" : "waiting",
    templates: template ? "done" : "waiting",
    designer: template?.cropArea && template.variables.length ? "done" : template?.cropArea ? "warning" : "waiting",
    csv: dataset ? "done" : "waiting",
    mapping: template?.variables.length && mappedCount === template.variables.length ? "done" : mappedCount ? "warning" : "waiting",
    layout: selectedRowIds.length ? "done" : "warning",
    export: template?.cropArea && dataset && selectedRowIds.length ? "ready" : "waiting",
  };
}

function safeFileName(name) {
  return String(name || "template")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function getPrintableRows(dataset, selectedRowIds) {
  if (!dataset?.rows?.length) return [];
  if (!selectedRowIds.length) return dataset.rows;
  return selectedRowIds
    .map((id) => dataset.rows[Number(id)])
    .filter(Boolean);
}

function sampleValue(dataset, header) {
  if (isMappingFunction(header)) return resolveMappedValue(header, {});
  const value = dataset?.rows?.find((row) => row[header] !== undefined && row[header] !== "")?.[header];
  return value ? `sample: ${value}` : "-";
}

function getPrintableRowEntries(dataset, selectedRowIds) {
  if (!dataset?.rows?.length) return [];
  const ids = selectedRowIds.length ? selectedRowIds : dataset.rows.map((_, index) => String(index));
  return ids
    .map((id) => ({ row: dataset.rows[Number(id)], index: String(id) }))
    .filter((entry) => entry.row);
}

function getRowCopyCount(rowCopies, rowId) {
  return Math.max(1, Number(rowCopies?.[rowId]) || 1);
}

function previewValuesFromRow(template, dataset, mapping, row) {
  if (!template) return {};
  const currentRow = row ?? {};
  return template.variables.reduce((values, variable) => {
    const source = mapping?.[variable.id];
    const value = resolveMappedValue(source, currentRow);
    if (source && value !== "") values[variable.id] = String(value);
    return values;
  }, {});
}

function isMappingFunction(source) {
  return typeof source === "string" && source.startsWith(MAPPING_FUNCTION_PREFIX);
}

function formatTodayDate(format) {
  const date = new Date();
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  if (format === "yyyy/mm/dd") return `${yyyy}/${mm}/${dd}`;
  if (format === "yyyymmdd") return `${yyyy}${mm}${dd}`;
  return "";
}

function resolveMappedValue(source, row) {
  if (!source) return "";
  if (!isMappingFunction(source)) {
    const value = row?.[source];
    return value === undefined || value === null ? "" : String(value);
  }
  if (source === `${MAPPING_FUNCTION_PREFIX}today_yyyy_mm_dd`) return formatTodayDate("yyyy/mm/dd");
  if (source === `${MAPPING_FUNCTION_PREFIX}today_yyyymmdd`) return formatTodayDate("yyyymmdd");
  return "";
}

function mappingSourceLabel(source, t) {
  if (!isMappingFunction(source)) return source;
  const found = MAPPING_FUNCTIONS.find((item) => item.key === source);
  return found ? t(found.labelKey) : source;
}

function getCropPointSize(template, fallbackPageSize = null) {
  const page = template?.sourcePdf?.pageSize ?? fallbackPageSize;
  if (!page || !template?.cropArea) return null;
  return {
    width: template.cropArea.widthRatio * page.width,
    height: template.cropArea.heightRatio * page.height,
  };
}

function getPrintedTemplateSize(layout, cropSize) {
  if (!cropSize) return null;
  if (layout.sizeMode === "actual") return cropSize;
  const paper = orientedPaper(layout);
  const cellWidth = (paper.width - layout.marginX * 2 - layout.gapX * Math.max(0, layout.columns - 1)) / layout.columns;
  const cellHeight = (paper.height - layout.marginY * 2 - layout.gapY * Math.max(0, layout.rows - 1)) / layout.rows;
  const scale = Math.min(cellWidth / cropSize.width, cellHeight / cropSize.height);
  return { width: cropSize.width * scale, height: cropSize.height * scale };
}

function pointsToCm(points) {
  return ((points / 72) * 2.54).toFixed(1);
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function rectStyle(rect) {
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}

function orientedPaper(layout) {
  const paper = PAPER_SIZES[layout.paperSize];
  if (layout.orientation === "landscape") return { width: paper.height, height: paper.width };
  return paper;
}

function expandRowEntries(entries, rowCopies) {
  return entries.flatMap((entry) => Array.from({ length: getRowCopyCount(rowCopies, entry.index) }, () => entry));
}

async function loadPdfFonts(outputDoc) {
  const [regularBytes, boldBytes] = await Promise.all([
    fetch(PDF_FONTS.regular).then(assertFontResponse).then((response) => response.arrayBuffer()),
    fetch(PDF_FONTS.bold).then(assertFontResponse).then((response) => response.arrayBuffer()),
  ]);
  const regularFont = await outputDoc.embedFont(regularBytes, { subset: false });
  const boldFont = await outputDoc.embedFont(boldBytes, { subset: false });
  return { regularFont, boldFont };
}

async function loadPdfJsDocumentWithFallback(arrayBuffer) {
  try {
    const loaded = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
    return { loaded, normalizedBytes: null };
  } catch (originalError) {
    const normalizedBytes = await tryNormalizePdfBytes(arrayBuffer);
    if (!normalizedBytes) throw originalError;
    const loaded = await pdfjsLib.getDocument({ data: new Uint8Array(normalizedBytes) }).promise;
    return { loaded, normalizedBytes };
  }
}

async function tryNormalizePdfBytes(arrayBuffer) {
  try {
    const doc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
    const bytes = await doc.save({ useObjectStreams: false });
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  } catch {
    return null;
  }
}

function assertFontResponse(response) {
  if (!response.ok) {
    throw new Error(`Failed to load bundled CJK export font: ${response.status} ${response.url}`);
  }
  return response;
}

async function decodeCsvFile(file, selectedEncoding) {
  const buffer = await file.arrayBuffer();
  if (selectedEncoding !== "auto") {
    return { text: decodeText(buffer, selectedEncoding), encoding: selectedEncoding, detected: false };
  }

  const utf8Text = decodeText(buffer, "utf-8");
  if (isCleanUtf8Csv(utf8Text)) {
    return { text: utf8Text, encoding: "utf-8", detected: true };
  }

  const candidates = ["utf-8", "shift_jis", "gb18030", "big5"];
  const decoded = candidates
    .map((encoding) => tryDecodeCsvCandidate(buffer, encoding))
    .filter(Boolean);
  if (!decoded.length) throw new Error("CSV decoding failed in this browser.");
  decoded.sort((a, b) => b.score - a.score);
  return { text: decoded[0].text, encoding: decoded[0].encoding, detected: true };
}

function tryDecodeCsvCandidate(buffer, encoding) {
  try {
    const text = decodeText(buffer, encoding);
    return { text, encoding, score: scoreDecodedCsv(text) };
  } catch {
    return null;
  }
}

function decodeText(buffer, encoding) {
  const decoder = new TextDecoder(encoding, { fatal: false });
  return decoder.decode(buffer).replace(/^\uFEFF/, "");
}

function scoreDecodedCsv(text) {
  const replacementCount = (text.match(/\uFFFD/g) || []).length;
  const cjkCount = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
  const kanaCount = (text.match(/[\u3040-\u30ff]/g) || []).length;
  const commaCount = (text.match(/[,;\t]/g) || []).length;
  const lineCount = (text.match(/\r\n|\n|\r/g) || []).length;
  const mojibakeCount = (text.match(/[繧縺譁莨荳蜷鬟]/g) || []).length;
  return cjkCount * 2 + kanaCount * 4 + commaCount + lineCount - replacementCount * 30 - mojibakeCount * 12;
}

function isCleanUtf8Csv(text) {
  const replacementCount = (text.match(/\uFFFD/g) || []).length;
  if (replacementCount > 0) return false;
  const separators = (text.match(/[,;\t]/g) || []).length;
  const lines = (text.match(/\r\n|\n|\r/g) || []).length;
  const cjkCount = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
  return separators > 0 && lines > 0 && cjkCount > 0;
}

function encodingLabel(encoding = "utf-8") {
  return CSV_ENCODINGS.find((item) => item.value === encoding)?.label ?? encoding.toUpperCase();
}

function fitFontSize(text, size, width, height, autoFit, font) {
  if (!autoFit) return size;
  let next = size;
  while (
    next > 4
    && (font.widthOfTextAtSize(text, next) > width || next * 1.12 > height)
  ) {
    next -= 0.5;
  }
  return next;
}

function printWindowHtml(t, titleKey, pdfUrl) {
  const title = t(titleKey);
  if (!pdfUrl) {
    return `<!doctype html>
      <title>${escapeHtml(title)}</title>
      <style>
        html, body { margin: 0; font-family: sans-serif; }
        .loading { align-items: center; display: flex; gap: 10px; padding: 24px; font-size: 22px; }
        .spinner {
          animation: spin 0.8s linear infinite;
          border: 3px solid rgba(20, 31, 43, 0.18);
          border-radius: 999px;
          border-top-color: #146c5f;
          display: inline-block;
          height: 18px;
          width: 18px;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>
      <div class="loading"><span class="spinner" aria-hidden="true"></span><span>${escapeHtml(t("printWindow.generatingTitle"))}</span></div>`;
  }
  const safeUrl = escapeHtml(pdfUrl);
  return `<!doctype html>
    <title>${escapeHtml(title)}</title>
    <style>
      html, body { height: 100%; margin: 0; font-family: sans-serif; }
      .bar { align-items: center; display: flex; gap: 12px; padding: 10px 14px; border-bottom: 1px solid #dbe3ec; }
      iframe { border: 0; height: calc(100% - 54px); width: 100%; }
      a, button { font: inherit; padding: 7px 10px; }
    </style>
    <div class="bar">
      <strong>${escapeHtml(t("printWindow.printableTitle"))}</strong>
      <a href="${safeUrl}" target="_blank" rel="noopener">${escapeHtml(t("printWindow.openDirect"))}</a>
      <button onclick="document.querySelector('iframe').contentWindow?.print()">${escapeHtml(t("printWindow.print"))}</button>
    </div>
    <iframe src="${safeUrl}" title="${escapeHtml(t("printWindow.printableTitle"))}"></iframe>`;
}

function downloadBlobUrl(url, fileName) {
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function alignX(box, textWidth, alignValue) {
  if (alignValue === "right") return box.x + box.width - textWidth;
  if (alignValue === "center") return box.x + (box.width - textWidth) / 2;
  return box.x;
}

function alignY(box, size, alignValue) {
  if (alignValue === "top") return box.y + box.height - size;
  if (alignValue === "middle") return box.y + (box.height - size) / 2;
  return box.y;
}

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  const value = parseInt(clean, 16);
  return rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
}

function normalizeColor(value) {
  return value && value !== "transparent" ? value : "#ffffff";
}

function justify(value) {
  return { left: "flex-start", center: "center", right: "flex-end" }[value] ?? "center";
}

function align(value) {
  return { top: "flex-start", middle: "center", bottom: "flex-end" }[value] ?? "center";
}

function fmtRect(rect) {
  return `x:${rect.x.toFixed(1)} y:${rect.y.toFixed(1)} w:${rect.width.toFixed(1)} h:${rect.height.toFixed(1)}`;
}

function fmtRatio(rect) {
  return `x:${rect.xRatio.toFixed(4)} y:${rect.yRatio.toFixed(4)} w:${rect.widthRatio.toFixed(4)} h:${rect.heightRatio.toFixed(4)}`;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

createRoot(document.getElementById("root")).render(<App />);



