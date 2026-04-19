#include <Servo.h>
#include <ctype.h>
#include <stdlib.h>
#include <string.h>

#define SERIAL_BAUD_RATE 115200

#define SERVO_PIN 10
#define SERVO_MIN_DEGREES 0
#define SERVO_MAX_DEGREES 180
#define SERVO_DEFAULT_DEGREES 90

#define MOTOR_1_DIR_PIN 6
#define MOTOR_1_STEP_PIN 7
#define MOTOR_1_ENABLE_PIN 8

#define MOTOR_2_DIR_PIN 0
#define MOTOR_2_STEP_PIN 1
#define MOTOR_2_ENABLE_PIN 2

#define MOTOR_1_STEP_INTERVAL_US 200UL
#define MOTOR_2_STEP_INTERVAL_US 200UL
#define MOTOR_1_DIRECTION HIGH
#define MOTOR_2_DIRECTION LOW

#define COMMAND_BUFFER_SIZE 48

struct StepperState
{
  uint8_t dirPin;
  uint8_t stepPin;
  uint8_t enablePin;
  uint8_t direction;
  uint32_t intervalUs;
  uint32_t lastToggleUs;
  bool stepPinHigh;
};

Servo testServo;
char commandBuffer[COMMAND_BUFFER_SIZE];
uint8_t commandLength = 0;
int currentServoDegrees = SERVO_DEFAULT_DEGREES;
StepperState motor1 = {MOTOR_1_DIR_PIN, MOTOR_1_STEP_PIN, MOTOR_1_ENABLE_PIN, MOTOR_1_DIRECTION, MOTOR_1_STEP_INTERVAL_US, 0UL, false};
StepperState motor2 = {MOTOR_2_DIR_PIN, MOTOR_2_STEP_PIN, MOTOR_2_ENABLE_PIN, MOTOR_2_DIRECTION, MOTOR_2_STEP_INTERVAL_US, 0UL, false};

static void processSerial(void);
static bool executeCommand(char * line);
static void uppercaseInPlace(char * text);
static void trimWhitespace(char * text);
static bool parseDegrees(char * text, int * degrees);
static bool isInRange(long value, long minValue, long maxValue);
static void sendOk(void);
static void sendError(const char * reason);
static void sendHelp(void);
static void initStepper(StepperState * motor);
static void serviceStepper(StepperState * motor, uint32_t nowUs);

void setup()
{
  testServo.attach(SERVO_PIN);
  testServo.write(currentServoDegrees);

  initStepper(&motor1);
  initStepper(&motor2);

  Serial.begin(SERIAL_BAUD_RATE);
  while (!Serial && millis() < 4000)
  {
    delay(10);
  }

  Serial.println("SERVO_STEPPER_TEST_READY");
  sendHelp();
  sendOk();
}

void loop()
{
  processSerial();
  uint32_t nowUs = micros();
  serviceStepper(&motor1, nowUs);
  serviceStepper(&motor2, nowUs);
}

static void processSerial(void)
{
  while (Serial.available() > 0)
  {
    char incoming = static_cast<char>(Serial.read());

    if (incoming == '\r')
    {
      continue;
    }

    if (incoming == '\n')
    {
      commandBuffer[commandLength] = '\0';

      if (commandLength > 0)
      {
        executeCommand(commandBuffer);
      }

      commandLength = 0;
      continue;
    }

    if (commandLength < (COMMAND_BUFFER_SIZE - 1))
    {
      commandBuffer[commandLength++] = incoming;
    }
    else
    {
      commandLength = 0;
      sendError("COMMAND_TOO_LONG");
    }
  }
}

static bool executeCommand(char * line)
{
  trimWhitespace(line);
  uppercaseInPlace(line);

  if (line[0] == '\0')
  {
    return true;
  }

  Serial.print("CMD:");
  Serial.println(line);

  if (strcmp(line, "HELP") == 0)
  {
    sendHelp();
    sendOk();
    return true;
  }

  char * separator = strchr(line, ':');
  char * payload = nullptr;
  if (separator != nullptr)
  {
    *separator = '\0';
    payload = separator + 1;
  }

  if (strcmp(line, "STATUS") == 0)
  {
    Serial.print("SERVO:");
    Serial.println(currentServoDegrees);
    Serial.println("STEPPERS:RUNNING");
    sendOk();
    return true;
  }

  if (strcmp(line, "SERVO") == 0)
  {
    int degrees = 0;
    if (payload == nullptr || !parseDegrees(payload, &degrees))
    {
      sendError("BAD_SERVO_ARGS");
      return false;
    }

    currentServoDegrees = degrees;
    testServo.write(currentServoDegrees);
    Serial.print("SERVO:");
    Serial.println(currentServoDegrees);
    sendOk();
    return true;
  }

  sendError("UNKNOWN_COMMAND");
  return false;
}

static void uppercaseInPlace(char * text)
{
  if (text == nullptr)
  {
    return;
  }

  for (size_t i = 0; text[i] != '\0'; i++)
  {
    text[i] = static_cast<char>(toupper(static_cast<unsigned char>(text[i])));
  }
}

static void trimWhitespace(char * text)
{
  if (text == nullptr)
  {
    return;
  }

  size_t len = strlen(text);
  size_t start = 0;

  while (start < len && isspace(static_cast<unsigned char>(text[start])) != 0)
  {
    start++;
  }

  while (len > start && isspace(static_cast<unsigned char>(text[len - 1])) != 0)
  {
    len--;
  }

  if (start > 0)
  {
    memmove(text, text + start, len - start);
  }

  text[len - start] = '\0';
}

static bool parseDegrees(char * text, int * degrees)
{
  char * endPtr = nullptr;
  long value = 0;

  if (text == nullptr || text[0] == '\0')
  {
    return false;
  }

  trimWhitespace(text);
  value = strtol(text, &endPtr, 10);
  if (endPtr == text || *endPtr != '\0')
  {
    return false;
  }

  if (!isInRange(value, SERVO_MIN_DEGREES, SERVO_MAX_DEGREES))
  {
    return false;
  }

  *degrees = static_cast<int>(value);
  return true;
}

static bool isInRange(long value, long minValue, long maxValue)
{
  return value >= minValue && value <= maxValue;
}

static void sendOk(void)
{
  Serial.println("OK");
}

static void sendError(const char * reason)
{
  Serial.print("ERR:");
  Serial.println(reason);
}

static void sendHelp(void)
{
  Serial.println("HELP:SERVO:<0-180> | STATUS | HELP");
}

static void initStepper(StepperState * motor)
{
  pinMode(motor->dirPin, OUTPUT);
  pinMode(motor->stepPin, OUTPUT);
  pinMode(motor->enablePin, OUTPUT);

  digitalWrite(motor->dirPin, motor->direction);
  digitalWrite(motor->stepPin, LOW);
  digitalWrite(motor->enablePin, LOW);

  motor->lastToggleUs = micros();
  motor->stepPinHigh = false;
}

static void serviceStepper(StepperState * motor, uint32_t nowUs)
{
  if ((nowUs - motor->lastToggleUs) >= (motor->intervalUs / 2UL))
  {
    motor->stepPinHigh = !motor->stepPinHigh;
    digitalWrite(motor->stepPin, motor->stepPinHigh ? HIGH : LOW);
    motor->lastToggleUs = nowUs;
  }
}
