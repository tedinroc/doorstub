# Doorstub 錢包探測頁：使用說明

這一頁要回答一個問題：真實的錢包（Selene、Paytaca、Cashonize、OPTN）肯不肯在「我們的合約輸入」旁邊簽自己的輸入，還有它們的確認畫面長什麼樣子。這是整個 Doorstub 能不能做的關鍵。

## 先說安全

- **什麼都不會送出，錢不會動。** 頁面只請錢包「簽名」，每個請求都寫明 `broadcast: false`（不要廣播）。
- **每一筆交易都至少有一個捏造的輸入**（一個根本不存在的幣）。就算某個錢包不聽話自己廣播，網路也會直接拒絕，不可能上鏈。
- 頁面裡**沒有任何廣播的程式碼**。它只會連兩種東西：WizardConnect 的中繼站（用來和錢包配對），還有你按「Scan」時對公開 Fulcrum 伺服器做的唯讀查詢。
- A-real 會用到你真正的幣來簽名，但同一筆交易裡還有捏造的輸入，而錢包的簽名（SIGHASH_ALL）綁住整筆交易的所有輸入，所以這個簽名拿到任何其他交易都無效。你的幣不會被花掉。
- 這句只在 A-real 顯示 PASS 時成立：頁面只挑剛好夠用的最小幾個幣，A-real 簽好的交易不會存進瀏覽器、也不會出現在匯出的 JSON 裡；但如果 A-real 出現任何 FAIL（特別是 sighash 那一行），分享任何東西之前，先把那些幣轉到新地址。
- 不用付任何手續費。

## 要準備什麼

- 一台桌機或筆電，用 Chrome 或 Safari 開頁面。
- iPhone 上的 Selene（2026.10 以上的版本）。
- Paytaca（手機 App）。
- Cashonize 網頁版（在桌機瀏覽器開，需要 HD 錢包；新建錢包預設就是 HD，裡面不用有錢）。
- OPTN：只有你手邊有 Android 手機才做。
- （可選）A-real 需要錢包裡有至少 14,000 sats（約 0.00014 BCH）的普通 BCH（不是代幣），而且放在前 21 個收款或找零地址上。沒有就跳過 A-real，其他照做。

每個錢包大約 5 到 10 分鐘。

## 怎麼打開頁面

**首選：直接打開單一檔案，不需要伺服器。** 用 Chrome 打開 repo 裡的 `dist/doorstub-probe.html`（Finder 裡雙擊，或在終端機執行 `open -a "Google Chrome" dist/doorstub-probe.html`）。這個檔案已經用模擬錢包從 `file://` 跑過完整流程（A-free、B、C 通過，D 照預期被拒）。檔案不在或太舊時，先執行 `npm run probe:build` 重新產生。

備案：在 repo 資料夾執行 `npm run probe`，再打開 http://localhost:5180 。這個伺服器要一直開著，關掉終端機頁面就會進不去。

## 測試順序

依照這個順序，一次一個錢包：

1. **Selene（iPhone）**：用 iPhone 掃桌機螢幕上的 QR。
2. **Paytaca**：用「Copy link」複製連結，貼進 Paytaca。
3. **Cashonize 網頁版**：按「Open in Cashonize」。
4. **OPTN**：只有在你有 Android 手機時才做（用「Copy link」或掃 QR）。

## 每個錢包的步驟

1. 按 **Connect wallet**。畫面會出現 QR 和三個按鈕。
2. 讓錢包配對：
   - Selene：在 Selene 裡打開 WizardConnect 的掃描器，掃桌機上的 QR。Selene 會問你要不要分享公鑰（xpub），按同意。
   - Paytaca：按 **Copy link**，把連結送到手機（Apple 的「通用剪貼簿」最快：同一個 Apple ID、藍牙和 Wi-Fi 打開，在 iPhone 上直接貼上；或用 AirDrop 傳給自己）。在 Paytaca 裡找 WizardConnect（在 Apps 裡），貼上連結。如果 Paytaca 有掃描器，也可以直接掃 QR。
   - Cashonize：按 **Open in Cashonize**，會在新分頁打開 cashonize.com。如果還沒有錢包，先在那裡建一個（不用放錢），然後同意連線。
   - OPTN：用 **Copy link** 貼上，或掃 QR。
3. 配對成功後，頁面第 1 區會顯示錢包名稱和「Receive 0」地址。確認名稱對。
4. 在第 3 區的文字框補上版本和裝置，例如 `Selene 2026.10.02, iPhone 15, 掃桌機 QR`。
5. 依序按：**Sign A-free → Sign B → Sign C → Sign D**。
   - 每按一個，就去錢包看確認畫面，**先截圖**（畫面很長就往下捲，每一段都截），然後按同意。
   - D 預期會被 Selene 拒絕：把錢包顯示的錯誤訊息也截圖。
   - 一次只能送一個請求。等頁面顯示結果，再按下一個。
6. （可選）按 **Scan for real coins (read-only)**。如果找到幣，**Sign A-real** 就會亮起來，照樣按、截圖、同意。注意：Scan 會把這個錢包前 42 個地址拿去問公開的 Fulcrum 伺服器（只查詢，不送任何東西）；不想讓伺服器看到這些地址，就跳過 A-real。
7. 換下一個錢包前，按 **Disconnect, pair another wallet**，再從第 1 步開始。

全部做完後，按 **Copy results JSON**（或 **Download JSON**），把 JSON 和所有截圖一起交回來分析。結果會留在這個瀏覽器裡，重新整理頁面也不會不見，直到你按「Clear results」。

## 要截哪些圖

每個錢包、每個形狀（A-free、A-real、B、C、D）各截：

- 錢包的**確認畫面**，整頁（金額、NFT、地址、提示文字都要拍到）。
- 如果錢包拒絕或出錯：**錯誤畫面**。
- 配對時的**同意畫面**（只要截一次）。

最後再截一張頁面的 **Results** 表格。

檔名建議：`selene-A-free.png`、`paytaca-D.png` 這樣。

看確認畫面時，順便注意這幾件事（這就是評審第一眼會看到的）：

- 有沒有顯示我們的提示文字「Doorstub probe: sign only, nothing is sent」。
- 金額怎麼顯示：是淨額、總額，還是看起來像你虧了一大筆。
- 有沒有顯示收到一張 NFT（票）。
- 合約地址顯示成什麼（一串 `bitcoincash:r...` 的地址、「script」、還是「未知」）。
- 找零有沒有被認成是你自己的。

## 錢包確認畫面上會看到的金額（全部是假的）

| 形狀 | 錢包會看到 |
|---|---|
| A-free | 花掉一個 50,000 sats 的幣（不存在）；11,000 sats 進合約（票價 10,000 加 1,000 押在託管標記上）；收到一張票 NFT（裡面有 1,000 sats）；其餘扣掉約 900 sats 手續費後找零回到你的地址 |
| A-real | 同上，但用的是你真的幣（交易仍然無效，不會發生） |
| B 退票 | 交回一張票 NFT，收到大約 11,000 sats 退款 |
| C 入場 | 交出票，大約 10,000 sats 付給主辦方，票以紀念票根的形式回到你的地址 |
| D | 和 B 一樣，但票的資料多了 1 個位元組（41 bytes） |

這些都不會真的發生。

## 結果是什麼意思

每個形狀做完，頁面會顯示一個標籤：

- **PASS**：錢包簽了，而且一切正確：合約輸入沒被動過、每個輸出都和我們送出的一模一樣、簽名正確（SIGHASH 0x61 或 0x41、金鑰和地址相符），並且整筆交易在 2026 版的 BCH 虛擬機（標準和共識兩種模式）都驗證通過。**這就是我們要的。**
- **REFUSED**：錢包拒絕簽。頁面會顯示錢包的原文（「Wallet error text」）。
  - 在 A、B、C 出現：這是最重要的發現。請截圖並記下原文。
    - 如果是你自己按了拒絕，原文通常是「使用者拒絕」之類，請在備註裡說明。
    - 如果是「Invalid signing source output…」：錢包不接受我們送的來源輸出格式。
    - 如果提到 input、path、key：錢包不認為那個輸入是它自己的。
  - 在 D 出現：**這是預期的**（頁面會顯示綠色的「REFUSED (expected)」）。Selene 拒絕承諾資料超過 40 bytes 的 NFT。預期原文是 `Invalid signing source output at index 1`。
- **SIGNED (no 40-byte limit)**：只會出現在 D。代表這個錢包沒有 40 bytes 的限制，照樣簽了。這不是壞事，只是記錄。頁面另外檢查它自己那個輸入的簽名是否正確。（D 的合約輸入本來就故意過不了驗證。）
- **FAIL**：錢包簽了，但有東西不對。點開「checks」，看哪一行標著 **NO**：
  - `outputs byte-equal`：錢包改了輸出。
  - `covenant input 0 untouched`：錢包動了合約輸入。
  - `wallet input … sighash 0x61 or 0x41`：簽名類型不對（例如 NONE 或 ANYONECANPAY；這種簽名可能被挪到別的路徑用，所以算失敗）。
  - `key matches its address`：用錯了金鑰。
  - `VM 2026 …`：交易在虛擬機驗證失敗。
- **WAITING** 停很久：錢包沒收到請求，或在等你同意。把錢包 App 切到前景。還是沒有的話，按 **Cancel** 再按一次 Sign；再不行就按 Disconnect 重新配對。
- **CANCELLED**：你在頁面上按了 Cancel。

## 常見狀況

- **QR 掃不到**：把瀏覽器放大（Cmd 加 +），或換用 Copy link。
- **Selene 沒反應**：確認版本是 2026.10 以上；把 Selene 切到前景；必要時重新配對。
- **Cashonize 說不支援**：WizardConnect 只支援 HD 錢包，請用新建的預設錢包。
- **Copy results JSON 被瀏覽器擋住**：頁面會直接在下方顯示 JSON 文字框，全選複製即可；或按 Download JSON 下載檔案。
- **中繼站斷線**：頁面會顯示「Relay reconnecting」，通常幾秒內會自己接回。

## 給開發者：自我測試

不需要手機，也可以先確認頁面能用：

- 離線單元測試（模擬錢包，用 libauth 簽名）：`node --test "probe/test/*.test.js"`
- 透過公開中繼站的端到端測試（模擬錢包使用 `@wizardconnect/wallet`，助記詞是一次性的、從來沒有錢）：`node probe/scripts/relay-selftest.js --scan`
- 讓模擬錢包連上正在開的頁面：先在頁面按 Copy link，再執行
  `node probe/scripts/sim-wallet-cli.js "<貼上 wiz:// 連結>"`
  （加 `--lenient` 就不會拒絕 41 bytes；加 `--ecdsa` 就改用 ECDSA 簽名）。
