import BookModel from "../../../models/Book";
import HtmlBookModel from "../../../models/HtmlBook";
export interface SettingPanelProps {
  currentBook: BookModel;
  htmlBook: HtmlBookModel;
  backgroundColor: string;
  isSettingLocked: boolean;
  readerMode: string;
  t: (title: string) => string;
  handleSettingLock: (isSettingLocked: boolean) => void;
  renderBookFunc: () => void;
}
export interface SettingPanelState {
  isShowMenu: boolean;
  isTranslationOpen: boolean;
  isSettingLocked: boolean;
}
