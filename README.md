# 察覺錶（aware-watch）網站

腕戴式重複行為察覺錶的公開網站：瀏覽器模擬器、網頁燒錄、信標程式碼、系統簡介。

- 線上：https://henrychao521.github.io/aware-watch/
- `index.html` 模擬器（介面與判斷規則照韌體 v0.7 重寫；洗手機率由情境產生，不是真實模型）
- `flash.html` 用 esptool-js 以 Web Serial 燒錄 `firmware/` 下的預編譯韌體（手錶一套、信標六套）
- `code.html`、`code/beacon_tx.ino` 信標原始碼
- `about.html`、`系統簡介.pdf` 系統、材料與研究依據

手錶韌體原始碼與偵測模型不在此 repo。研究原型，非醫療器材。
燒錄工具 `vendor/esptool-js.bundle.js` 來自 Espressif esptool-js（Apache-2.0）。
