// Waage – BLE-Neigungssensor für Einachsfahrzeuge
// Board: Seeed XIAO nRF52840 Sense, Core "Seeed nRF52 Boards" (nicht "mbed-enabled")
//
// Liefert per BLE die Neigung der Sensor-X- und -Y-Achse (Grad gegenüber der Waagerechten).
// Die Umrechnung in "mm unterbauen" und die Zuordnung links/rechts/vorne macht die App.

#include <bluefruit.h>
#include <Wire.h>
#include <Adafruit_LittleFS.h>
#include <InternalFileSystem.h>

using namespace Adafruit_LittleFS_Namespace;

// ---------------------------------------------------------------------------
// BLE-Protokoll (muss zu app/app.js passen)
//   Service      6f1a0001-3c2b-4d5e-8f90-a1b2c3d4e5f6
//   Tilt  (read/notify, 6 Byte): int16 winkelX [0,01°], int16 winkelY [0,01°], uint8 flags, uint8 reserviert
//                                flags: bit0 = ruhig, bit1 = Nullpunkt gesetzt
//   Ctrl  (write, 1 Byte):       0x01 = Nullpunkt setzen, 0x02 = Nullpunkt löschen
// UUIDs hier in Little-Endian-Reihenfolge (so erwartet sie Bluefruit).
// ---------------------------------------------------------------------------
const uint8_t UUID_SVC[]  = {0xf6, 0xe5, 0xd4, 0xc3, 0xb2, 0xa1, 0x90, 0x8f, 0x5e, 0x4d, 0x2b, 0x3c, 0x01, 0x00, 0x1a, 0x6f};
const uint8_t UUID_TILT[] = {0xf6, 0xe5, 0xd4, 0xc3, 0xb2, 0xa1, 0x90, 0x8f, 0x5e, 0x4d, 0x2b, 0x3c, 0x02, 0x00, 0x1a, 0x6f};
const uint8_t UUID_CTRL[] = {0xf6, 0xe5, 0xd4, 0xc3, 0xb2, 0xa1, 0x90, 0x8f, 0x5e, 0x4d, 0x2b, 0x3c, 0x03, 0x00, 0x1a, 0x6f};

const uint8_t CMD_SET_ZERO   = 0x01;
const uint8_t CMD_CLEAR_ZERO = 0x02;

const uint8_t FLAG_STABLE   = 0x01;
const uint8_t FLAG_ZERO_SET = 0x02;

BLEService        svc(UUID_SVC);
BLECharacteristic chrTilt(UUID_TILT);
BLECharacteristic chrCtrl(UUID_CTRL);

// ---------------------------------------------------------------------------
// LSM6DS3TR-C (intern an Wire1, Adresse 0x6A)
// ---------------------------------------------------------------------------
const uint8_t IMU_ADDR     = 0x6A;
const uint8_t REG_WHO_AM_I = 0x0F;
const uint8_t REG_CTRL1_XL = 0x10;
const uint8_t REG_CTRL3_C  = 0x12;
const uint8_t REG_STATUS   = 0x1E;
const uint8_t REG_OUTX_L_XL = 0x28;

const uint32_t BLOCK_MS          = 200;   // Mittelungsfenster = Sendeintervall
const uint8_t  ZERO_BLOCKS       = 15;    // 3 s Mittelung für den Nullpunkt
const float    STABLE_LIMIT_DEG  = 0.05f; // max. Änderung zum vorigen Block für "ruhig"
const char*    ZERO_FILE         = "/zero.bin";

// ---------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------
volatile bool connected = false;
volatile uint8_t pendingCmd = 0;   // vom BLE-Callback gesetzt, in loop() abgearbeitet

bool imuOn = false;

// Rotation, die den beim Nullen gemessenen Schwerkraftvektor auf die Z-Achse dreht.
// Gleicht aus, dass der Sensor nie exakt waagerecht montiert ist.
float zeroRot[3][3] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
bool zeroSet = false;

// Blockmittelung
double sumX = 0, sumY = 0, sumZ = 0;
uint16_t nSamples = 0;
uint32_t blockStart = 0;
float lastAngX = 1000, lastAngY = 1000;  // Ergebnis des vorigen Blocks

// Nullpunkt-Messung
uint8_t zeroBlocksLeft = 0;
double zeroSumX = 0, zeroSumY = 0, zeroSumZ = 0;

// ---------------------------------------------------------------------------
// IMU
// ---------------------------------------------------------------------------
void imuWrite(uint8_t reg, uint8_t val) {
  Wire1.beginTransmission(IMU_ADDR);
  Wire1.write(reg);
  Wire1.write(val);
  Wire1.endTransmission();
}

bool imuRead(uint8_t reg, uint8_t* buf, uint8_t len) {
  Wire1.beginTransmission(IMU_ADDR);
  Wire1.write(reg);
  if (Wire1.endTransmission(false) != 0) return false;
  if (Wire1.requestFrom(IMU_ADDR, len) != len) return false;
  for (uint8_t i = 0; i < len; i++) buf[i] = Wire1.read();
  return true;
}

bool imuStart() {
  pinMode(PIN_LSM6DS3TR_C_POWER, OUTPUT);
  digitalWrite(PIN_LSM6DS3TR_C_POWER, HIGH);
  delay(50);  // Boot-Zeit des Sensors
  Wire1.begin();

  uint8_t who = 0;
  if (!imuRead(REG_WHO_AM_I, &who, 1) || (who != 0x6A && who != 0x69)) {
    Serial.print("IMU nicht gefunden, WHO_AM_I=0x");
    Serial.println(who, HEX);
    return false;
  }
  imuWrite(REG_CTRL3_C, 0x44);   // BDU=1, IF_INC=1
  imuWrite(REG_CTRL1_XL, 0x40);  // Beschleunigung 104 Hz, ±2 g; Gyro bleibt aus
  delay(20);
  return true;
}

void imuStop() {
  imuWrite(REG_CTRL1_XL, 0x00);
  Wire1.end();
  digitalWrite(PIN_LSM6DS3TR_C_POWER, LOW);  // Sensor komplett stromlos
}

// Liefert true, wenn ein neuer Messwert vorlag. Einheit egal, nur die Richtung zählt.
bool imuSample(float& x, float& y, float& z) {
  uint8_t status;
  if (!imuRead(REG_STATUS, &status, 1) || !(status & 0x01)) return false;
  uint8_t b[6];
  if (!imuRead(REG_OUTX_L_XL, b, 6)) return false;
  x = (int16_t)(b[0] | (b[1] << 8));
  y = (int16_t)(b[2] | (b[3] << 8));
  z = (int16_t)(b[4] | (b[5] << 8));
  return true;
}

// ---------------------------------------------------------------------------
// Winkelrechnung
// ---------------------------------------------------------------------------
void applyZero(float& x, float& y, float& z) {
  float rx = zeroRot[0][0] * x + zeroRot[0][1] * y + zeroRot[0][2] * z;
  float ry = zeroRot[1][0] * x + zeroRot[1][1] * y + zeroRot[1][2] * z;
  float rz = zeroRot[2][0] * x + zeroRot[2][1] * y + zeroRot[2][2] * z;
  x = rx; y = ry; z = rz;
}

// Neigung der Sensor-X- bzw. -Y-Achse gegenüber der Waagerechten in Grad.
// Positiv heißt: das +X- bzw. +Y-Ende liegt höher.
void tiltAngles(float x, float y, float z, float& angX, float& angY) {
  float g = sqrtf(x * x + y * y + z * z);
  if (g < 1) { angX = angY = 0; return; }
  angX = degrees(asinf(x / g));
  angY = degrees(asinf(y / g));
}

// Rodrigues-Rotation, die den normierten Vektor g auf (0,0,1) abbildet.
bool computeZeroRotation(float x, float y, float z) {
  float g = sqrtf(x * x + y * y + z * z);
  if (g < 1) return false;
  x /= g; y /= g; z /= g;
  if (z < 0.5f) return false;  // mehr als 60° schief oder kopfüber montiert

  // Drehachse k = g × z = (y, -x, 0), sin = |k|, cos = z
  float s = sqrtf(x * x + y * y);
  float c = z;
  if (s < 1e-6f) {
    float id[3][3] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
    memcpy(zeroRot, id, sizeof(zeroRot));
    return true;
  }
  float kx = y / s, ky = -x / s;  // kz = 0
  float t = 1 - c;
  zeroRot[0][0] = c + kx * kx * t;
  zeroRot[0][1] = kx * ky * t;
  zeroRot[0][2] = ky * s;
  zeroRot[1][0] = kx * ky * t;
  zeroRot[1][1] = c + ky * ky * t;
  zeroRot[1][2] = -kx * s;
  zeroRot[2][0] = -ky * s;
  zeroRot[2][1] = kx * s;
  zeroRot[2][2] = c;
  return true;
}

// ---------------------------------------------------------------------------
// Nullpunkt im Flash
// ---------------------------------------------------------------------------
void loadZero() {
  File f(InternalFS);
  if (!f.open(ZERO_FILE, FILE_O_READ)) return;
  if (f.read(zeroRot, sizeof(zeroRot)) == sizeof(zeroRot)) zeroSet = true;
  f.close();
}

void saveZero() {
  InternalFS.remove(ZERO_FILE);
  File f(InternalFS);
  if (f.open(ZERO_FILE, FILE_O_WRITE)) {
    f.write((uint8_t*)zeroRot, sizeof(zeroRot));
    f.close();
  }
}

void clearZero() {
  float id[3][3] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
  memcpy(zeroRot, id, sizeof(zeroRot));
  zeroSet = false;
  InternalFS.remove(ZERO_FILE);
}

// ---------------------------------------------------------------------------
// BLE
// ---------------------------------------------------------------------------
void onConnect(uint16_t connHandle) {
  (void)connHandle;
  connected = true;
}

void onDisconnect(uint16_t connHandle, uint8_t reason) {
  (void)connHandle;
  (void)reason;
  connected = false;
}

void onCtrlWrite(uint16_t connHandle, BLECharacteristic* chr, uint8_t* data, uint16_t len) {
  (void)connHandle;
  (void)chr;
  if (len >= 1) pendingCmd = data[0];
}

void setupBle() {
  Bluefruit.begin();
  Bluefruit.autoConnLed(false);  // blaue LED nicht blinken lassen, spart Strom
  Bluefruit.setTxPower(4);
  Bluefruit.setName("Waage");
  Bluefruit.Periph.setConnectCallback(onConnect);
  Bluefruit.Periph.setDisconnectCallback(onDisconnect);

  svc.begin();

  chrTilt.setProperties(CHR_PROPS_READ | CHR_PROPS_NOTIFY);
  chrTilt.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  chrTilt.setFixedLen(6);
  chrTilt.begin();

  chrCtrl.setProperties(CHR_PROPS_WRITE);
  chrCtrl.setPermission(SECMODE_NO_ACCESS, SECMODE_OPEN);
  chrCtrl.setFixedLen(1);
  chrCtrl.setWriteCallback(onCtrlWrite);
  chrCtrl.begin();

  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addService(svc);
  Bluefruit.ScanResponse.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 1600);  // 20 ms schnell, danach 1 s (Einheit 0,625 ms)
  Bluefruit.Advertising.setFastTimeout(30);
  Bluefruit.Advertising.start(0);
}

// ---------------------------------------------------------------------------
// Messablauf
// ---------------------------------------------------------------------------
void resetBlock() {
  sumX = sumY = sumZ = 0;
  nSamples = 0;
  blockStart = millis();
}

void finishBlock() {
  if (nSamples == 0) return;
  float x = sumX / nSamples, y = sumY / nSamples, z = sumZ / nSamples;

  if (zeroBlocksLeft > 0) {
    zeroSumX += x; zeroSumY += y; zeroSumZ += z;
    if (--zeroBlocksLeft == 0) {
      if (computeZeroRotation(zeroSumX, zeroSumY, zeroSumZ)) {
        zeroSet = true;
        saveZero();
        Serial.println("Nullpunkt gespeichert");
      } else {
        Serial.println("Nullpunkt abgelehnt (Sensor zu schief montiert?)");
      }
    }
  }

  applyZero(x, y, z);
  float angX, angY;
  tiltAngles(x, y, z, angX, angY);

  bool stable = fabsf(angX - lastAngX) < STABLE_LIMIT_DEG && fabsf(angY - lastAngY) < STABLE_LIMIT_DEG;
  lastAngX = angX;
  lastAngY = angY;
  uint8_t flags = (stable ? FLAG_STABLE : 0) | (zeroSet ? FLAG_ZERO_SET : 0);

  int16_t cx = (int16_t)lroundf(angX * 100);
  int16_t cy = (int16_t)lroundf(angY * 100);
  uint8_t pkt[6] = {(uint8_t)(cx & 0xFF), (uint8_t)(cx >> 8), (uint8_t)(cy & 0xFF), (uint8_t)(cy >> 8), flags, 0};
  chrTilt.write(pkt, sizeof(pkt));
  if (chrTilt.notifyEnabled()) chrTilt.notify(pkt, sizeof(pkt));
}

void handleCommand(uint8_t cmd) {
  switch (cmd) {
    case CMD_SET_ZERO:
      // Messung ohne bisherige Korrektur, damit der neue Nullpunkt absolut gilt
      clearZero();
      zeroSumX = zeroSumY = zeroSumZ = 0;
      zeroBlocksLeft = ZERO_BLOCKS;
      break;
    case CMD_CLEAR_ZERO:
      zeroBlocksLeft = 0;
      clearZero();
      break;
  }
}

void setup() {
  Serial.begin(115200);
  InternalFS.begin();
  loadZero();
  setupBle();
  resetBlock();
}

void loop() {
  // Sensor nur bei bestehender Verbindung betreiben
  if (connected && !imuOn) {
    imuOn = imuStart();
    resetBlock();
  } else if (!connected && imuOn) {
    imuStop();
    imuOn = false;
    zeroBlocksLeft = 0;
  }

  if (!imuOn) {
    delay(200);  // FreeRTOS schläft hier, nRF52 geht in den Stromsparmodus
    return;
  }

  uint8_t cmd = pendingCmd;
  if (cmd) {
    pendingCmd = 0;
    handleCommand(cmd);
  }

  float x, y, z;
  if (imuSample(x, y, z)) {
    sumX += x; sumY += y; sumZ += z;
    nSamples++;
  }

  if (millis() - blockStart >= BLOCK_MS) {
    finishBlock();
    resetBlock();
  }

  delay(5);
}
