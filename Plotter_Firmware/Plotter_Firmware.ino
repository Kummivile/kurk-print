#include "stepperMotor.h"
#include <Servo.h>
#include <ctype.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#define SERIAL_BAUD_RATE 115200

#define SERVO_PIN 10
#define SERVO_PEN_UP_ANGLE 90
#define SERVO_PEN_DOWN_ANGLE 25
#define PEN_DWELL_MS 180

#define PLOTTER_MAX_X 199
#define PLOTTER_MAX_Y 289

#define DEFAULT_HOME_X 0
#define DEFAULT_HOME_Y 0

#define X_MOTOR MOTOR_1
#define Y_MOTOR MOTOR_2

#define X_STEPS_PER_PLOT_UNIT 16L
#define Y_STEPS_PER_PLOT_UNIT 80L

#define X_DIRECTION_INVERTED 0
#define Y_DIRECTION_INVERTED 0

#define STEP_INTERVAL_US 500
#define DOT_DURATION_MS 120

#define CIRCLE_SEGMENT_LENGTH_UNITS 4
#define ARC_SEGMENT_LENGTH_UNITS 4

#define COMMAND_BUFFER_SIZE 96
struct Point
{
  int16_t x;
  int16_t y;
};

static const uint16_t LOGO_POINT_COUNT = 189;
static const Point logoPoints[LOGO_POINT_COUNT] = {
  {118, 51},
  {122, 59},
  {127, 67},
  {131, 75},
  {136, 83},
  {141, 91},
  {145, 100},
  {150, 108},
  {154, 116},
  {151, 111},
  {147, 107},
  {143, 100},
  {138, 94},
  {133, 88},
  {128, 81},
  {131, 87},
  {133, 92},
  {135, 96},
  {138, 100},
  {140, 105},
  {143, 109},
  {145, 114},
  {148, 118},
  {150, 122},
  {147, 118},
  {143, 113},
  {138, 107},
  {134, 101},
  {129, 94},
  {124, 88},
  {126, 94},
  {129, 99},
  {131, 103},
  {133, 108},
  {136, 112},
  {138, 117},
  {140, 121},
  {143, 126},
  {145, 130},
  {141, 125},
  {138, 120},
  {134, 115},
  {131, 110},
  {127, 105},
  {123, 100},
  {120, 95},
  {116, 90},
  {113, 85},
  {109, 80},
  {105, 83},
  {101, 87},
  {96, 91},
  {92, 95},
  {88, 99},
  {83, 99},
  {78, 93},
  {75, 88},
  {72, 82},
  {68, 76},
  {65, 71},
  {62, 65},
  {59, 59},
  {55, 54},
  {52, 48},
  {49, 42},
  {46, 36},
  {50, 42},
  {54, 47},
  {58, 53},
  {63, 58},
  {67, 64},
  {72, 70},
  {68, 63},
  {66, 59},
  {63, 54},
  {61, 50},
  {59, 45},
  {56, 41},
  {54, 37},
  {51, 32},
  {49, 28},
  {53, 33},
  {58, 39},
  {62, 45},
  {66, 51},
  {70, 56},
  {75, 62},
  {73, 56},
  {70, 52},
  {68, 47},
  {66, 43},
  {63, 38},
  {61, 34},
  {59, 29},
  {56, 25},
  {54, 20},
  {58, 25},
  {61, 30},
  {65, 35},
  {68, 40},
  {72, 45},
  {76, 50},
  {79, 55},
  {83, 61},
  {86, 66},
  {90, 71},
  {94, 67},
  {98, 63},
  {102, 59},
  {107, 55},
  {111, 51},
  {116, 51},
  {118, 51},
  {-1, -1},
  {107, 159},
  {107, 149},
  {100, 149},
  {100, 159},
  {93, 159},
  {93, 149},
  {-1, -1},
  {107, 162},
  {107, 172},
  {-1, -1},
  {107, 167},
  {93, 167},
  {-1, -1},
  {107, 175},
  {107, 185},
  {93, 185},
  {93, 175},
  {107, 175},
  {-1, -1},
  {93, 188},
  {107, 188},
  {93, 197},
  {107, 197},
  {-1, -1},
  {107, 210},
  {107, 201},
  {93, 201},
  {93, 210},
  {-1, -1},
  {100, 201},
  {100, 209},
  {-1, -1},
  {93, 214},
  {107, 214},
  {107, 222},
  {106, 223},
  {102, 223},
  {100, 222},
  {100, 214},
  {-1, -1},
  {100, 218},
  {93, 223},
  {-1, -1},
  {107, 227},
  {107, 236},
  {-1, -1},
  {107, 231},
  {93, 231},
  {-1, -1},
  {93, 227},
  {93, 236},
  {-1, -1},
  {93, 239},
  {107, 239},
  {107, 247},
  {105, 249},
  {95, 249},
  {93, 247},
  {93, 239},
  {-1, -1},
  {104, 262},
  {107, 262},
  {107, 252},
  {93, 252},
  {93, 262},
  {99, 262},
  {99, 258},
  {-1, -1},
  {107, 275},
  {107, 265},
  {93, 265},
  {93, 275},
  {-1, -1},
  {100, 265},
  {100, 273}
};

Servo penServo;
char commandBuffer[COMMAND_BUFFER_SIZE];
uint8_t commandLength = 0;

Point currentPosition = {DEFAULT_HOME_X, DEFAULT_HOME_Y};
Point homePosition = {DEFAULT_HOME_X, DEFAULT_HOME_Y};
bool penIsDown = false;

static void penUp(void);
static void penDown(void);
static void processSerial(void);
static bool executeCommand(char * line);
static void splitCommandAndPayload(char * line, char ** command, char ** payload);
static bool parsePoint(char * text, Point * point);
static bool parseLongValue(char * text, long * value);
static bool parseNonNegativeLong(char * text, long * value);
static bool isPointInBounds(const Point & point);
static bool isLongInRange(long value, long minValue, long maxValue);
static void sendOk(void);
static void sendError(const char * reason);
static void trimWhitespace(char * text);
static void uppercaseInPlace(char * text);
static char * findWhitespace(char * text);
static long plotUnitsToStepsX(long units);
static long plotUnitsToStepsY(long units);
static bool travelTo(int16_t targetX, int16_t targetY);
static bool drawTo(int16_t targetX, int16_t targetY);
static bool moveTo(int16_t targetX, int16_t targetY, bool drawingMove);
static void runAxesDelta(long deltaXSteps, long deltaYSteps);
static bool drawDot(int16_t x, int16_t y);
static bool drawLine(int16_t x1, int16_t y1, int16_t x2, int16_t y2);
static bool drawSquare(int16_t x, int16_t y, int16_t width, int16_t height);
static bool drawCircle(int16_t centerX, int16_t centerY, int16_t radius);
static bool drawArc(int16_t centerX, int16_t centerY, int16_t radius, int16_t startAngle, int16_t endAngle);
static bool drawLogo(void);
static bool moveHome(void);
static bool drawPolyline(const Point * points, uint16_t pointCount);
static int segmentCountForArc(long radius, long spanDegrees, long desiredSegmentLength);

void setup()
{
  Stepper_Init();

  Serial.begin(SERIAL_BAUD_RATE);
  while (!Serial && millis() < 4000)
  {
    delay(10);
  }

  Serial.println("PLOTTER_READY");
  Serial.println("INFO:Set X/Y calibration and servo angles before final use");
  sendOk();
}

void loop()
{
  processSerial();
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

  char * command = nullptr;
  char * payload = nullptr;
  splitCommandAndPayload(line, &command, &payload);

  if (strcmp(command, "HOME") == 0)
  {
    if (payload != nullptr && payload[0] != '\0')
    {
      sendError("HOME_TAKES_NO_ARGS");
      return false;
    }

    if (moveHome())
    {
      sendOk();
      return true;
    }

    sendError("HOME_FAILED");
    return false;
  }

  if (strcmp(command, "LOGO") == 0)
  {
    if (payload != nullptr && payload[0] != '\0')
    {
      sendError("LOGO_TAKES_NO_ARGS");
      return false;
    }

    if (drawLogo())
    {
      sendOk();
      return true;
    }

    sendError("LOGO_FAILED");
    return false;
  }

  if (payload == nullptr || payload[0] == '\0')
  {
    sendError("MISSING_ARGS");
    return false;
  }

  if (strcmp(command, "MOV") == 0)
  {
    Point point;
    if (!parsePoint(payload, &point))
    {
      sendError("BAD_MOV_ARGS");
      return false;
    }

    if (!moveTo(point.x, point.y, false))
    {
      sendError("MOV_OUT_OF_RANGE");
      return false;
    }

    sendOk();
    return true;
  }

  if (strcmp(command, "DOT") == 0)
  {
    Point point;
    if (!parsePoint(payload, &point))
    {
      sendError("BAD_DOT_ARGS");
      return false;
    }

    if (!drawDot(point.x, point.y))
    {
      sendError("DOT_FAILED");
      return false;
    }

    sendOk();
    return true;
  }

  if (strcmp(command, "LINE") == 0)
  {
    char * token = strtok(payload, ",");
    long values[4];
    uint8_t count = 0;

    while (token != nullptr && count < 4)
    {
      trimWhitespace(token);
      if (!parseLongValue(token, &values[count]))
      {
        sendError("BAD_LINE_ARGS");
        return false;
      }

      token = strtok(nullptr, ",");
      count++;
    }

    if (count != 4 || token != nullptr)
    {
      sendError("BAD_LINE_ARGS");
      return false;
    }

    if (!drawLine(static_cast<int16_t>(values[0]), static_cast<int16_t>(values[1]),
                  static_cast<int16_t>(values[2]), static_cast<int16_t>(values[3])))
    {
      sendError("LINE_FAILED");
      return false;
    }

    sendOk();
    return true;
  }

  if (strcmp(command, "SQUARE") == 0)
  {
    char * token = strtok(payload, ",");
    long values[4];
    uint8_t count = 0;

    while (token != nullptr && count < 4)
    {
      trimWhitespace(token);
      if (!parseNonNegativeLong(token, &values[count]))
      {
        sendError("BAD_SQUARE_ARGS");
        return false;
      }

      token = strtok(nullptr, ",");
      count++;
    }

    if (count != 4 || token != nullptr)
    {
      sendError("BAD_SQUARE_ARGS");
      return false;
    }

    if (!drawSquare(static_cast<int16_t>(values[0]), static_cast<int16_t>(values[1]),
                    static_cast<int16_t>(values[2]), static_cast<int16_t>(values[3])))
    {
      sendError("SQUARE_FAILED");
      return false;
    }

    sendOk();
    return true;
  }

  if (strcmp(command, "CIRCLE") == 0)
  {
    char * token = strtok(payload, ",");
    long values[3];
    uint8_t count = 0;

    while (token != nullptr && count < 3)
    {
      trimWhitespace(token);
      if (!parseNonNegativeLong(token, &values[count]))
      {
        sendError("BAD_CIRCLE_ARGS");
        return false;
      }

      token = strtok(nullptr, ",");
      count++;
    }

    if (count != 3 || token != nullptr)
    {
      sendError("BAD_CIRCLE_ARGS");
      return false;
    }

    if (!drawCircle(static_cast<int16_t>(values[0]), static_cast<int16_t>(values[1]),
                    static_cast<int16_t>(values[2])))
    {
      sendError("CIRCLE_FAILED");
      return false;
    }

    sendOk();
    return true;
  }

  if (strcmp(command, "ARC") == 0)
  {
    char * token = strtok(payload, ",");
    long values[5];
    uint8_t count = 0;

    while (token != nullptr && count < 5)
    {
      trimWhitespace(token);
      if (!parseLongValue(token, &values[count]))
      {
        sendError("BAD_ARC_ARGS");
        return false;
      }

      token = strtok(nullptr, ",");
      count++;
    }

    if (count != 5 || token != nullptr)
    {
      sendError("BAD_ARC_ARGS");
      return false;
    }

    if (values[2] < 0)
    {
      sendError("BAD_ARC_RADIUS");
      return false;
    }

    if (!drawArc(static_cast<int16_t>(values[0]), static_cast<int16_t>(values[1]),
                 static_cast<int16_t>(values[2]), static_cast<int16_t>(values[3]),
                 static_cast<int16_t>(values[4])))
    {
      sendError("ARC_FAILED");
      return false;
    }

    sendOk();
    return true;
  }

  sendError("UNKNOWN_COMMAND");
  return false;
}

static void splitCommandAndPayload(char * line, char ** command, char ** payload)
{
  char * separator = strchr(line, ':');

  *command = line;
  *payload = nullptr;

  if (separator != nullptr)
  {
    *separator = '\0';
    *payload = separator + 1;
  }
  else
  {
    char * whitespace = findWhitespace(line);
    if (whitespace != nullptr)
    {
      *whitespace = '\0';
      *payload = whitespace + 1;
    }
  }

  trimWhitespace(*command);
  if (*payload != nullptr)
  {
    trimWhitespace(*payload);
  }
}

static bool parsePoint(char * text, Point * point)
{
  char * first = strtok(text, ",");
  char * second = strtok(nullptr, ",");
  char * third = strtok(nullptr, ",");
  long xValue;
  long yValue;

  if (first == nullptr || second == nullptr || third != nullptr)
  {
    return false;
  }

  trimWhitespace(first);
  trimWhitespace(second);

  if (!parseLongValue(first, &xValue) || !parseLongValue(second, &yValue))
  {
    return false;
  }

  if (!isLongInRange(xValue, 0, PLOTTER_MAX_X) || !isLongInRange(yValue, 0, PLOTTER_MAX_Y))
  {
    return false;
  }

  point->x = static_cast<int16_t>(xValue);
  point->y = static_cast<int16_t>(yValue);
  return true;
}

static bool parseLongValue(char * text, long * value)
{
  char * endPtr = nullptr;

  if (text == nullptr || text[0] == '\0')
  {
    return false;
  }

  *value = strtol(text, &endPtr, 10);
  return (endPtr != text && *endPtr == '\0');
}

static bool parseNonNegativeLong(char * text, long * value)
{
  if (!parseLongValue(text, value))
  {
    return false;
  }

  return (*value >= 0);
}

static bool isPointInBounds(const Point & point)
{
  return isLongInRange(point.x, 0, PLOTTER_MAX_X) && isLongInRange(point.y, 0, PLOTTER_MAX_Y);
}

static bool isLongInRange(long value, long minValue, long maxValue)
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

static char * findWhitespace(char * text)
{
  if (text == nullptr)
  {
    return nullptr;
  }

  for (size_t i = 0; text[i] != '\0'; i++)
  {
    if (isspace(static_cast<unsigned char>(text[i])) != 0)
    {
      return text + i;
    }
  }

  return nullptr;
}

static long plotUnitsToStepsX(long units)
{
  return units * X_STEPS_PER_PLOT_UNIT;
}

static long plotUnitsToStepsY(long units)
{
  return units * Y_STEPS_PER_PLOT_UNIT;
}

static void penUp(void)
{
  if (!penServo.attached())
  {
    penServo.attach(SERVO_PIN);
  }

  penServo.write(SERVO_PEN_UP_ANGLE);
  delay(PEN_DWELL_MS);
  penIsDown = false;
}

static void penDown(void)
{
  if (!penServo.attached())
  {
    penServo.attach(SERVO_PIN);
  }

  penServo.write(SERVO_PEN_DOWN_ANGLE);
  delay(PEN_DWELL_MS);
  penIsDown = true;
}

static bool moveTo(int16_t targetX, int16_t targetY, bool drawingMove)
{
  Point target = {targetX, targetY};

  if (!isPointInBounds(target))
  {
    return false;
  }

  if (drawingMove)
  {
    if (!penIsDown)
    {
      penDown();
    }
  }
  else if (penIsDown)
  {
    penUp();
  }

  long currentXSteps = plotUnitsToStepsX(currentPosition.x);
  long currentYSteps = plotUnitsToStepsY(currentPosition.y);
  long targetXSteps = plotUnitsToStepsX(target.x);
  long targetYSteps = plotUnitsToStepsY(target.y);

  runAxesDelta(targetXSteps - currentXSteps, targetYSteps - currentYSteps);
  currentPosition = target;
  return true;
}

static bool travelTo(int16_t targetX, int16_t targetY)
{
  return moveTo(targetX, targetY, false);
}

static bool drawTo(int16_t targetX, int16_t targetY)
{
  return moveTo(targetX, targetY, true);
}

static void runAxesDelta(long deltaXSteps, long deltaYSteps)
{
  long absX = labs(deltaXSteps);
  long absY = labs(deltaYSteps);
  long maxSteps = (absX > absY) ? absX : absY;
  long errorX = 0;
  long errorY = 0;

  if (maxSteps == 0)
  {
    return;
  }

  Stepper_SetDirection(X_MOTOR, (((deltaXSteps >= 0) ? 1 : 0) ^ X_DIRECTION_INVERTED) ? 1 : 0);
  Stepper_SetDirection(Y_MOTOR, (((deltaYSteps >= 0) ? 1 : 0) ^ Y_DIRECTION_INVERTED) ? 1 : 0);

  Stepper_SetEnabled(X_MOTOR, absX > 0);
  Stepper_SetEnabled(Y_MOTOR, absY > 0);

  for (long step = 0; step < maxSteps; step++)
  {
    errorX += absX;
    if (errorX >= maxSteps)
    {
      Stepper_StepOnce(X_MOTOR, STEP_INTERVAL_US);
      errorX -= maxSteps;
    }

    errorY += absY;
    if (errorY >= maxSteps)
    {
      Stepper_StepOnce(Y_MOTOR, STEP_INTERVAL_US);
      errorY -= maxSteps;
    }
  }

  Stepper_SetEnabled(X_MOTOR, false);
  Stepper_SetEnabled(Y_MOTOR, false);
}

static bool drawDot(int16_t x, int16_t y)
{
  if (!travelTo(x, y))
  {
    return false;
  }

  penDown();
  delay(DOT_DURATION_MS);
  penUp();
  return true;
}

static bool drawLine(int16_t x1, int16_t y1, int16_t x2, int16_t y2)
{
  Point start = {x1, y1};
  Point end = {x2, y2};

  if (!isPointInBounds(start) || !isPointInBounds(end))
  {
    return false;
  }

  if (!travelTo(x1, y1))
  {
    return false;
  }

  if (!drawTo(x2, y2))
  {
    return false;
  }

  penUp();
  return true;
}

static bool drawSquare(int16_t x, int16_t y, int16_t width, int16_t height)
{
  long right = static_cast<long>(x) + width;
  long bottom = static_cast<long>(y) + height;

  if (!isLongInRange(x, 0, PLOTTER_MAX_X) || !isLongInRange(y, 0, PLOTTER_MAX_Y) ||
      !isLongInRange(right, 0, PLOTTER_MAX_X) || !isLongInRange(bottom, 0, PLOTTER_MAX_Y))
  {
    return false;
  }

  if (!travelTo(x, y))
  {
    return false;
  }

  if (!drawTo(static_cast<int16_t>(right), y) ||
      !drawTo(static_cast<int16_t>(right), static_cast<int16_t>(bottom)) ||
      !drawTo(x, static_cast<int16_t>(bottom)) ||
      !drawTo(x, y))
  {
    return false;
  }

  penUp();
  return true;
}

static bool drawCircle(int16_t centerX, int16_t centerY, int16_t radius)
{
  if (radius < 0)
  {
    return false;
  }

  int segments = segmentCountForArc(radius, 360, CIRCLE_SEGMENT_LENGTH_UNITS);
  bool firstPoint = true;

  for (int i = 0; i <= segments; i++)
  {
    float angleRadians = (360.0f * i / segments) * DEG_TO_RAD;
    long x = lround(centerX + (cos(angleRadians) * radius));
    long y = lround(centerY + (sin(angleRadians) * radius));
    Point point = {static_cast<int16_t>(x), static_cast<int16_t>(y)};

    if (!isPointInBounds(point))
    {
      return false;
    }

    if (firstPoint)
    {
      if (!travelTo(point.x, point.y))
      {
        return false;
      }

      firstPoint = false;
    }
    else
    {
      if (!drawTo(point.x, point.y))
      {
        return false;
      }
    }
  }

  penUp();
  return true;
}

static bool drawArc(int16_t centerX, int16_t centerY, int16_t radius, int16_t startAngle, int16_t endAngle)
{
  if (radius < 0)
  {
    return false;
  }

  long sweep = endAngle - startAngle;
  long sweepAbs = labs(sweep);

  if (sweepAbs == 0)
  {
    sweepAbs = 360;
  }

  int segments = segmentCountForArc(radius, sweepAbs, ARC_SEGMENT_LENGTH_UNITS);
  float angleStep = static_cast<float>(sweep) / segments;

  if (sweep == 0)
  {
    angleStep = 360.0f / segments;
  }

  bool firstPoint = true;

  for (int i = 0; i <= segments; i++)
  {
    float angleDegrees = static_cast<float>(startAngle) + (angleStep * i);
    float angleRadians = angleDegrees * DEG_TO_RAD;
    long x = lround(centerX + (cos(angleRadians) * radius));
    long y = lround(centerY + (sin(angleRadians) * radius));
    Point point = {static_cast<int16_t>(x), static_cast<int16_t>(y)};

    if (!isPointInBounds(point))
    {
      return false;
    }

    if (firstPoint)
    {
      if (!travelTo(point.x, point.y))
      {
        return false;
      }

      firstPoint = false;
    }
    else
    {
      if (!drawTo(point.x, point.y))
      {
        return false;
      }
    }
  }

  penUp();
  return true;
}

static bool drawLogo(void)
{
  return drawPolyline(logoPoints, LOGO_POINT_COUNT);
}

static bool moveHome(void)
{
  penUp();
  return moveTo(homePosition.x, homePosition.y, false);
}

static bool drawPolyline(const Point * points, uint16_t pointCount)
{
  if (points == nullptr || pointCount == 0)
  {
    return false;
  }

  bool hasActivePath = false;

  for (uint16_t i = 0; i < pointCount; i++)
  {
    const Point point = points[i];

    if (point.x < 0 || point.y < 0)
    {
      if (penIsDown)
      {
        penUp();
      }
      hasActivePath = false;
      continue;
    }

    if (!hasActivePath)
    {
      if (!travelTo(point.x, point.y))
      {
        return false;
      }

      hasActivePath = true;
      continue;
    }

    if (!drawTo(point.x, point.y))
    {
      return false;
    }
  }

  penUp();
  return true;
}

static int segmentCountForArc(long radius, long spanDegrees, long desiredSegmentLength)
{
  long estimatedCircumference = (628L * radius) / 100L;
  long estimatedArcLength = (estimatedCircumference * spanDegrees) / 360L;
  long segments = estimatedArcLength / desiredSegmentLength;

  if (segments < 12)
  {
    segments = 12;
  }

  if (segments > 180)
  {
    segments = 180;
  }

  return static_cast<int>(segments);
}
