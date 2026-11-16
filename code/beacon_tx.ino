// beacon_tx — 用便宜的 ESP32（C3、S3 都可）當地點信標，給 bfrb_watch 的「地點」頁登錄
// 只廣播，不收資料、不連線。兩種格式擇一：
//   USE_IBEACON 1：標準 iBeacon（UUID＋major＋minor），市售信標 App 也看得到；錶上登錄後顯示「iBeacon ...」
//   USE_IBEACON 0：只廣播固定名稱
// 每顆信標改 MINOR（或名稱）就能區分：例如 1＝洗手台、2＝門口、3＝爐子
// 有螢幕的板子（LILYGO T-QT Pro）會顯示狀態：廣播中／停止、角色、運作時間；按任一鍵亮螢幕，30 秒後自動暗
#include <NimBLEDevice.h>

// 以下都可在編譯時用 -D 覆寫（網站上的三種角色就是這樣編出來的）
#ifndef USE_IBEACON
#define USE_IBEACON 1
#endif
#ifndef MAJOR
#define MAJOR 1
#endif
#ifndef MINOR
#define MINOR 1
#endif
static const char *NAMES[] = {"BEACON", "SINK-1", "DOOR-1", "STOVE-1"};
#define BEACON_NAME (MINOR < 4 ? NAMES[MINOR] : NAMES[0])
#define TX_AT_1M -59                                 // 1 公尺處的參考訊號（iBeacon 欄位，錶上不使用）
#ifndef HAS_TQT_SCREEN
#define HAS_TQT_SCREEN 1                             // LILYGO T-QT Pro（0.85 吋 GC9107）；沒螢幕的板子設 0
#endif
// 這個專案自己的 UUID（隨機產生，固定不變）
static const uint8_t UUID[16] = {0x6E, 0x3B, 0x2A, 0x51, 0x9C, 0x47, 0x4D, 0x18, 0xA5, 0x0F, 0x7C, 0x2E, 0x91, 0xB4, 0x36, 0xD2};
static const char *ROLE[] = {"", "洗手台", "門口", "爐子"};

static NimBLEAdvertising *adv;
static uint32_t restarts = 0;

#if HAS_TQT_SCREEN
#include <SPI.h>
#include <LovyanGFX.hpp>
// 腳位與初始化序列取自這塊板子原本的 circuit-lab 韌體（已驗證可顯示）
#define PIN_MOSI 2
#define PIN_SCLK 3
#define PIN_CS 5
#define PIN_DC 6
#define PIN_RST 1
#define PIN_BL 10                                    // 低電位亮
#define PIN_KEY1 0
#define PIN_KEY2 47
#define COL0 2
#define ROW0 1
static SPIClass lcdSpi(FSPI);
static LGFX_Sprite fb;                               // 128×128 畫面緩衝，畫完一次推到螢幕
static bool screenOn = true; static uint32_t lastKeyMs = 0;

static void lcdCmd(uint8_t c, const uint8_t *d = nullptr, size_t n = 0) {
  digitalWrite(PIN_DC, 0); digitalWrite(PIN_CS, 0); lcdSpi.transfer(c); digitalWrite(PIN_CS, 1);
  if (n) { digitalWrite(PIN_DC, 1); digitalWrite(PIN_CS, 0); lcdSpi.writeBytes(d, n); digitalWrite(PIN_CS, 1); }
}
static void lcdCmd1(uint8_t c, uint8_t v) { lcdCmd(c, &v, 1); }

static void lcdInit() {
  pinMode(PIN_CS, OUTPUT); pinMode(PIN_DC, OUTPUT); pinMode(PIN_RST, OUTPUT); pinMode(PIN_BL, OUTPUT);
  digitalWrite(PIN_CS, 1); digitalWrite(PIN_BL, 0);
  pinMode(PIN_KEY1, INPUT_PULLUP); pinMode(PIN_KEY2, INPUT_PULLUP);
  lcdSpi.begin(PIN_SCLK, -1, PIN_MOSI, -1);
  lcdSpi.beginTransaction(SPISettings(40000000, MSBFIRST, SPI_MODE0));
  digitalWrite(PIN_RST, 1); delay(20); digitalWrite(PIN_RST, 0); delay(50); digitalWrite(PIN_RST, 1); delay(120);
  lcdCmd(0xFE); lcdCmd(0xEF);
  const uint8_t regs[][2] = {{0xB0, 0xC0}, {0xB1, 0x80}, {0xB2, 0x27}, {0xB3, 0x13}, {0xB6, 0x19}, {0xB7, 0x05}, {0xAC, 0xC8},
                             {0xAB, 0x0F}, {0x3A, 0x05}, {0xB4, 0x04}, {0xA8, 0x08}, {0xB8, 0x08}, {0xEA, 0x02}, {0xE8, 0x2A},
                             {0xE9, 0x47}, {0xE7, 0x5F}, {0xC6, 0x21}, {0xC7, 0x15}};
  for (auto &r : regs) lcdCmd1(r[0], r[1]);
  const uint8_t g1[] = {0x1D, 0x38, 0x09, 0x4D, 0x92, 0x2F, 0x35, 0x52, 0x1E, 0x0C, 0x04, 0x12, 0x14, 0x1F};
  const uint8_t g2[] = {0x16, 0x40, 0x1C, 0x54, 0xA9, 0x2D, 0x2E, 0x56, 0x10, 0x0D, 0x0C, 0x1A, 0x14, 0x1E};
  const uint8_t f4[] = {0x00, 0x00, 0xFF}, ba[] = {0xFF, 0xFF};
  lcdCmd(0xF0, g1, sizeof(g1)); lcdCmd(0xF1, g2, sizeof(g2)); lcdCmd(0xF4, f4, 3); lcdCmd(0xBA, ba, 2);
  lcdCmd(0x20); lcdCmd1(0x36, 0x08);
  lcdCmd(0x11); delay(120); lcdCmd(0x29); delay(20);
  fb.setColorDepth(16); fb.createSprite(128, 128);
}

static void lcdPush() {
  const uint8_t ca[] = {0, COL0, 0, COL0 + 127}, ra[] = {0, ROW0, 0, ROW0 + 127};
  lcdCmd(0x2A, ca, 4); lcdCmd(0x2B, ra, 4);
  digitalWrite(PIN_DC, 0); digitalWrite(PIN_CS, 0); lcdSpi.transfer(0x2C);
  digitalWrite(PIN_DC, 1); lcdSpi.writeBytes((uint8_t *)fb.getBuffer(), 128 * 128 * 2); digitalWrite(PIN_CS, 1);
}

static void drawStatus(bool on) {
  uint32_t s = millis() / 1000;
  fb.fillScreen(TFT_BLACK);
  fb.setFont(&fonts::efontTW_16); fb.setTextDatum(top_center); fb.setTextColor(TFT_WHITE);
  fb.drawString(MINOR < 4 ? ROLE[MINOR] : "信標", 64, 6);
  // 狀態燈：廣播中＝綠色，每 0.3 秒（廣播間隔）亮一下；停止＝紅色
  uint16_t base = on ? 0x07E0 : 0xF800;
  bool blink = on && (millis() % 300) < 90;
  fb.fillCircle(64, 50, 16, on ? (blink ? 0xAFF5 : base) : base);
  fb.drawCircle(64, 50, 20, on ? 0x03E0 : 0x7800);
  fb.setFont(&fonts::efontTW_14); fb.setTextColor(on ? 0x07E0 : 0xF800);
  fb.drawString(on ? "廣播中" : "未廣播", 64, 74);
  char b[32]; fb.setFont(&fonts::efontTW_12); fb.setTextColor(0xAD55);
  snprintf(b, sizeof(b), "運作 %02lu:%02lu:%02lu", (unsigned long)(s / 3600), (unsigned long)(s / 60 % 60), (unsigned long)(s % 60));
  fb.drawString(b, 64, 94);
  snprintf(b, sizeof(b), USE_IBEACON ? "iB %02X%02X%02X%02X %d-%d" : "%s", UUID[0], UUID[1], UUID[2], UUID[3], MAJOR, MINOR);
  if (!USE_IBEACON) snprintf(b, sizeof(b), "%s", BEACON_NAME);
  fb.drawString(b, 64, 110);
  lcdPush();
}
#endif

static void startAdv() {
  if (USE_IBEACON) {
    // Apple iBeacon 格式：公司 0x004C、型別 0x02、長度 0x15，接 UUID、major、minor（大端序）、1 公尺訊號
    uint8_t m[25] = {0x4C, 0x00, 0x02, 0x15};
    memcpy(m + 4, UUID, 16);
    m[20] = MAJOR >> 8; m[21] = MAJOR & 0xFF; m[22] = MINOR >> 8; m[23] = MINOR & 0xFF; m[24] = (uint8_t)TX_AT_1M;
    NimBLEAdvertisementData d; d.setFlags(0x06); d.setManufacturerData(m, sizeof(m));
    NimBLEAdvertisementData sr; sr.setName(BEACON_NAME);      // 名稱放掃描回應，方便用手機 App 辨認
    adv->setAdvertisementData(d); adv->setScanResponseData(sr);
  } else {
    adv->setName(BEACON_NAME);
  }
  adv->setMinInterval(480); adv->setMaxInterval(480);   // 單位 0.625 ms → 300 ms 廣播一次
  adv->start();
}

void setup() {
  Serial.begin(115200);
#if HAS_TQT_SCREEN
  lcdInit(); drawStatus(false);
#endif
  NimBLEDevice::init(BEACON_NAME);
  NimBLEDevice::setPower(3);                         // dBm；房間大就調高
  adv = NimBLEDevice::getAdvertising();
  startAdv();
  Serial.printf("beacon_tx %s %s major=%d minor=%d\n", USE_IBEACON ? "iBeacon" : "name", BEACON_NAME, MAJOR, MINOR);
}

void loop() {
  static uint32_t lastLog = 0, lastDraw = 0;
  uint32_t now = millis();
  bool on = adv->isAdvertising();
  if (!on && now > 3000) { startAdv(); restarts++; }   // 萬一停了就重新開始，並記次數
  if (now - lastLog > 10000) { lastLog = now; Serial.printf("%s restarts=%lu\n", on ? "advertising" : "stopped", (unsigned long)restarts); }
#if HAS_TQT_SCREEN
  if (Serial.available() && Serial.read() == 's') {     // 測試用：送 s 印出畫面（base64，給電腦轉成圖檢查版面）
    while (Serial.available()) Serial.read();
    drawStatus(on); size_t n = 128 * 128 * 2; const uint8_t *p = (const uint8_t *)fb.getBuffer();
    static const char *B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    Serial.println("#SHOT");
    for (size_t i = 0; i < n; i += 3) {
      uint32_t v = p[i] << 16 | p[i + 1] << 8 | (i + 2 < n ? p[i + 2] : 0);
      char o[5] = {B64[v >> 18 & 63], B64[v >> 12 & 63], B64[v >> 6 & 63], i + 2 < n ? B64[v & 63] : '=', 0};
      Serial.print(o); if (i % 171 == 168) Serial.println();
    }
    Serial.println(); Serial.println("#END");
  }
  if (!digitalRead(PIN_KEY1) || !digitalRead(PIN_KEY2)) { lastKeyMs = now; if (!screenOn) { screenOn = true; digitalWrite(PIN_BL, 0); } }
  if (screenOn && now - lastKeyMs > 30000) { screenOn = false; digitalWrite(PIN_BL, 1); }
  if (screenOn && now - lastDraw > 50) { lastDraw = now; drawStatus(on); }
#endif
  delay(10);
}
