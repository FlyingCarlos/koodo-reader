import React from "react";
import "./operationPanel.css";
import Bookmark from "../../../models/Bookmark";
import { Trans } from "react-i18next";

import { OperationPanelProps, OperationPanelState } from "./interface";
import { ConfigService } from "../../../assets/lib/kookit-extra-browser.min";
import { withRouter } from "react-router-dom";
import toast from "react-hot-toast";
import TTSUtil from "../../../utils/reader/ttsUtil";
import { isElectron } from "react-device-detect";
import { handleExitFullScreen, handleFullScreen } from "../../../utils/common";
import DatabaseService from "../../../utils/storage/databaseService";
import BookLocation from "../../../models/BookLocation";
import BookUtil from "../../../utils/file/bookUtil";
import { isPdfBilingual, visiblePdfPage } from "../../../utils/reader/pdfTranslation";
import {
  importTranslationPdf, TranslationApiError, TranslationBook, translationApi,
} from "../../../components/bilingualReader/api";
declare var window: any;
class OperationPanel extends React.Component<
  OperationPanelProps,
  OperationPanelState
> {
  timeStamp: number;
  speed: number;
  timer: any;
  private openingBrowser = false;

  constructor(props: OperationPanelProps) {
    super(props);
    this.state = {
      isBookmark: false,
      time: 0,
      currentPercentage: ConfigService.getObjectConfig(
        this.props.currentBook.key,
        "recordLocation",
        {}
      )
        ? ConfigService.getObjectConfig(
            this.props.currentBook.key,
            "recordLocation",
            {}
          ).percentage
        : 0,
      timeLeft: 0,
      isFullscreen: ConfigService.getReaderConfig("isFullscreen") === "yes",
    };
    this.timeStamp = Date.now();
    this.speed = 30000;
  }

  handleFullscreenChange = () => {
    const isNowFullscreen = !!document.fullscreenElement;
    if (!isNowFullscreen) {
      ConfigService.setReaderConfig("isFullscreen", "no");
    }
    this.setState({ isFullscreen: isNowFullscreen });
  };

  componentDidMount() {
    document.addEventListener("fullscreenchange", this.handleFullscreenChange);
    this.props.htmlBook.rendition.on("page-changed", async () => {
      this.speed = Date.now() - this.timeStamp;
      this.timeStamp = Date.now();
      let pageProgress = await this.props.htmlBook.rendition.getProgress();
      this.setState({
        timeLeft:
          ((pageProgress.totalPage - pageProgress.currentPage) * this.speed) /
          1000,
      });
      this.handleDisplayBookmark();
    });
  }

  componentWillUnmount() {
    document.removeEventListener(
      "fullscreenchange",
      this.handleFullscreenChange
    );
  }

  handleShortcut() {}
  handleScreen() {
    const entering = ConfigService.getReaderConfig("isFullscreen") !== "yes";
    entering ? handleFullScreen() : handleExitFullScreen();
    if (entering) {
      ConfigService.setReaderConfig("isFullscreen", "yes");
      this.setState({ isFullscreen: true });
    } else {
      ConfigService.setReaderConfig("isFullscreen", "no");
      this.setState({ isFullscreen: false });
    }
  }
  async handleExit() {
    ConfigService.setReaderConfig("isFullscreen", "no");
    this.props.handleReadingState(false);
    this.props.handleSearch(false);
    window.speechSynthesis && window.speechSynthesis.cancel();
    TTSUtil.pauseAudio();
    handleExitFullScreen();
    if (this.props.htmlBook) {
      this.props.handleHtmlBook(null);
    }
    if (isElectron) {
      if (ConfigService.getReaderConfig("isOpenInMain") === "yes") {
        window.electronAPI.invoke("exit-tab", "ping");
      } else {
        window.electronAPI.invoke("exit-reader", "ping");
      }
    } else {
      ConfigService.setReaderConfig("isFinishWebReading", "yes");
      window.close();
    }
  }
  handleAddBookmark = async () => {
    let bookKey = this.props.currentBook.key;
    let bookLocation: BookLocation = ConfigService.getObjectConfig(
      bookKey,
      "recordLocation",
      {}
    );
    let text = bookLocation.text;
    let chapter = bookLocation.chapterTitle;
    let percentage = bookLocation.percentage;
    let isDuplicate = false;
    let bookmarks = await DatabaseService.getRecordsByBookKey(
      this.props.currentBook.key,
      "bookmarks"
    );
    for (let i = 0; i < bookmarks.length; i++) {
      if (
        bookmarks[i].percentage === bookLocation.percentage &&
        bookmarks[i].page === bookLocation.page
      ) {
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) {
      toast.error(this.props.t("Bookmark already exists"));
      return;
    }

    let cfi = JSON.stringify(bookLocation);
    if (!text) {
      text = (await this.props.htmlBook.rendition.visibleText()).join(" ");
    }
    text = text
      .replace(/\s\s/g, "")
      .replace(/\r/g, "")
      .replace(/\n/g, "")
      .replace(/\t/g, "")
      .replace(/\f/g, "");

    let bookmark = new Bookmark(
      bookKey,
      cfi,
      text.substr(0, 200),
      percentage,
      chapter
    );
    await DatabaseService.saveRecord(bookmark, "bookmarks");
    this.props.handleFetchBookmarks();
    this.setState({ isBookmark: true });
    this.props.handleShowBookmark(true);
  };
  async handleDisplayBookmark() {
    this.props.handleShowBookmark(false);
    let bookLocation: {
      text: string;
      count: string;
      chapterTitle: string;
      chapterDocIndex: string;
      chapterHref: string;
      percentage: string;
      cfi: string;
    } = ConfigService.getObjectConfig(
      this.props.currentBook.key,
      "recordLocation",
      {}
    );
    let bookmarks = await DatabaseService.getRecordsByBookKey(
      this.props.currentBook.key,
      "bookmarks"
    );
    bookmarks.forEach((item) => {
      if (item.cfi === JSON.stringify(bookLocation)) {
        this.props.handleShowBookmark(true);
      }
    });
  }
  handleOpenInBrowser = async () => {
    if (this.openingBrowser) return;
    this.openingBrowser = true;
    const { currentBook: book, htmlBook: { rendition } } = this.props;
    const page = visiblePdfPage(rendition) || Math.max(1,
      Number(rendition.getPosition()?.chapterDocIndex || 0) + 1 -
      (rendition.isStartFromEven === "yes" && rendition.readerMode === "double" ? 1 : 0)
    );
    const notice = toast.loading("正在打开浏览器阅读页…");
    try {
      let metadata: TranslationBook;
      try {
        metadata = await translationApi<TranslationBook>(`/books?key=${encodeURIComponent(book.key)}`);
      } catch (error) {
        if (!(error instanceof TranslationApiError) || error.status !== 404) throw error;
        const pdf = await BookUtil.fetchBook(book.key, "pdf", true, book.path);
        if (!pdf || typeof pdf === "boolean") throw new Error("无法读取原 PDF");
        metadata = await importTranslationPdf(book.key, book.name, pdf);
      }
      const opened = await window.electronAPI.invoke(
        "open-book-in-browser", metadata.id, page, isPdfBilingual(book.key)
      );
      if (!opened) throw new Error("无法打开浏览器");
      toast.dismiss(notice);
    } catch {
      toast.error("无法打开浏览器阅读页，请重试。", { id: notice });
    } finally {
      this.openingBrowser = false;
    }
  };
  render() {
    const canOpenBrowser = window.location.protocol === "koodo-desktop:" &&
      this.props.currentBook.format === "PDF";
    return (
      <div className={`book-operation-panel${canOpenBrowser ? " book-operation-panel-with-browser" : ""}`}>
        <div className="book-opeartion-info">
          <span>
            <Trans
              i18nKey="Current reading time"
              count={Math.floor(
                Math.abs(Math.floor(this.props.currentDuration / 60))
              )}
            >
              Current reading time:
              {{
                count: Math.abs(Math.floor(this.props.currentDuration / 60)),
              }}
              min
            </Trans>
          </span>
          &nbsp;&nbsp;&nbsp;
          <span>
            <Trans
              i18nKey="Remaining reading time"
              count={Math.ceil(this.state.timeLeft / 60)}
            >
              Remaining reading time:
              {{
                count: `${Math.ceil(this.state.timeLeft / 60)}`,
              }}
              min
            </Trans>
          </span>
        </div>
        <div
          className="exit-reading-button"
          onClick={() => {
            this.handleExit();
          }}
        >
          <div className="operation-button-container">
            <div style={{ display: "flex", alignItems: "center" }}>
              <span className="icon-exit exit-reading-icon"></span>
              <span className="exit-reading-text">
                <Trans>Exit</Trans>
              </span>
            </div>
          </div>
        </div>
        <div
          className="add-bookmark-button"
          onClick={() => {
            this.handleAddBookmark();
          }}
        >
          <div className="operation-button-container">
            <div style={{ display: "flex", alignItems: "center" }}>
              <span className="icon-add add-bookmark-icon"></span>
              <span className="add-bookmark-text">
                <Trans>Bookmark</Trans>
              </span>
            </div>
          </div>
        </div>
        <div
          className="enter-fullscreen-button"
          onClick={() => {
            this.handleScreen();
          }}
        >
          <div className="operation-button-container">
            <div style={{ display: "flex", alignItems: "center" }}>
              <span
                className={`${this.state.isFullscreen ? "icon-collapse" : "icon-fullscreen"} enter-fullscreen-icon`}
              ></span>
              <span className="enter-fullscreen-text">
                {this.state.isFullscreen ? (
                  <Trans>Exit full screen</Trans>
                ) : (
                  <Trans>Full screen</Trans>
                )}
              </span>
            </div>
          </div>
        </div>
        {canOpenBrowser && (
          <button type="button" className="open-browser-reading-button" onClick={this.handleOpenInBrowser}>
            在浏览器中阅读
          </button>
        )}
      </div>
    );
  }
}

export default withRouter(OperationPanel as any);
