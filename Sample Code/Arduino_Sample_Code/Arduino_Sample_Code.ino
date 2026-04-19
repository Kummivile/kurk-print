/* This example code shows how to drive two stepper motors
and a servo in parallel. 

The pin layout is the following:

SERVO - 10

These are the pins that are used to drive the DRV8825 controllers
which in turn control the two stepper motors.

STEPPER1 DIR    - 0
STEPPER1 STEP   - 1 
STEPPER1 ENABLE - 2

STEPPER2 DIR    - 6
STEPPER2 STEP   - 7
STEPPER2 ENABLE - 8

NOTE that these pins can be configured in stepperMotor.cpp as needed.
NOTE also that stepperMotor.cpp has been set up for 1/8 microstepping. Make sure that your DRV8825 setup matches this.
*/

/* We include stepperMotor.h - the header for the included stepper motor driver. */
#include "stepperMotor.h"
/* For the servo we use a built-in header file Servo.h */
#include <Servo.h>

#define SERVO_PIN 10
#define SERVO_EXTENDED 0
#define SERVO_RETRACTED 90

/* Assuming 1/8 microstepping. 1.8 degrees for 1 full step.
So a total of 200 full steps for 360 degrees, multiplied by 8, we get 1600 */
#define STEPS_PER_REVOLUTION 1600

static int direction = 1;
static bool isInitComplete = false;
Servo myServo;


void setup() 
{
  /* Initialize the stepper motor driver. */
  Stepper_Init();

  /* Initialize the servo. */
  myServo.attach(SERVO_PIN);

  /* Spin stepper 1 for one full revolution. Note that this is a blocking call. */
  Stepper_MoveBlocking(MOTOR_1, 800, 1, STEPS_PER_REVOLUTION);
  /* Spin stepper 2 for one full revolution in the other direction. */
  Stepper_MoveBlocking(MOTOR_2, 800, 0, STEPS_PER_REVOLUTION);

  /* Spin MOTOR_1 one step at a time and at twice the speed. The dir pin retains its previous state. */
  digitalWrite(8, LOW); // Set the enable pin for MOTOR_1 to LOW. (Motor enabled)
  for(int x = 0; x < STEPS_PER_REVOLUTION; x++)
  {
    Stepper_StepOnce(MOTOR_1, 400);
  }
  digitalWrite(8, HIGH); //Set the enable pin for MOTOR_1 to HIGH. (Motor disabled)

  /* Spin MOTOR_2 one step at a time. */
  digitalWrite(2, LOW); // Set the enable pin for MOTOR_1 to LOW. (Motor enabled)
  for(int x = 0; x < STEPS_PER_REVOLUTION; x++)
  {
    Stepper_StepOnce(MOTOR_2, 400);
  }
  digitalWrite(2, HIGH); //Set the enable pin for MOTOR_1 to HIGH. (Motor disabled)

  isInitComplete = true;
}


void loop()
{  
  if (isInitComplete == true)
  {
    delay(2000);
    myServo.write(SERVO_EXTENDED);
    /* NOTE that the speed parameter is actually the delay between steps. So a greater value means a greater delay and therefore slower movement speed. */
    /* We move MOTOR_1 for 3200 steps, with an interval of 200 microseconds between each step. */
    Stepper_StartNonBlocking(MOTOR_1, 800, direction, 3200);
    /* We move MOTOR_2 for 6400 steps with an interval of 100 microseconds between each step. **/
    Stepper_StartNonBlocking(MOTOR_2, 400, !direction, 6400);

    /* These calls are not blocking, unlike the call made in the setup() function. This means that we will have the stepper motors
    moving in parallel with different speeds. It is strongly recommended to investigate the contents of the stepper motor driver stepperMotor.cpp 
    to understand the inner workings of the driver.*/
    /* Wait for the motors to complete.  */
    while(Stepper_IsBusy());
    myServo.write(SERVO_RETRACTED);

    delay(2000);
    myServo.write(SERVO_EXTENDED);
    Stepper_StartNonBlocking(MOTOR_1, 400, direction, 6400);
    Stepper_StartNonBlocking(MOTOR_2, 800, !direction, 3200);
    
    /* Wait for the motors to complete.  */
    while(Stepper_IsBusy());
    myServo.write(SERVO_RETRACTED);

    direction = !direction;
  }
}
