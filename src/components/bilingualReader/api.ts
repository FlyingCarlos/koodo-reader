export type Chapter = {
  id: string;
  title: string;
  start_page: number;
  end_page: number;
  block_count: number;
  text_count: number;
};

export type TranslationBook = {
  id: string;
  title: string;
  page_count: number;
  chapters: Chapter[];
  outline: {
    title: string;
    level: number;
    page: number;
    chapter_id: string;
    block_id: string | null;
  }[];
  empty_text_pages: number[];
};

export type ChapterTask = {
  id: string;
  status: string;
  model: string;
  total: number;
  completed: number;
  drafted: number;
  needs_review: number;
  error_code: string | null;
};

export type ParallelBlock = {
  id: string;
  text: string;
  kind: "heading" | "paragraph" | "list" | "caption" | "code" | "image";
  page: number;
  end_page: number;
  anchors: { page: number; bbox: number[] }[];
  translation: { text: string; status: string } | null;
};

export type ChapterContent = {
  chapter: Chapter;
  task: ChapterTask | null;
  blocks: ParallelBlock[];
};

export class TranslationApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function translationApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/translation${path}`, {
    ...options,
    headers: { "X-Koodo-Translation": "1", ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new TranslationApiError(response.status, data.error || "翻译服务暂时不可用，请重试。");
  }
  return data;
}
