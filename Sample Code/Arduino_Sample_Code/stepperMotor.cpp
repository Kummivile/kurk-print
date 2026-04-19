#include "stepperMotor.h"
#include <FspTimer.h>
#include "Arduino.h"

typedef struct
{
  uint8_t dirPin;
  uint8_t stepPin;
  uint8_t enablePin;

  FspTimer * timer;
  GPTimerCbk_f callback;
} stepMotorConf_T;

typedef struct
{
  uint32_t step_target;
  uint32_t curr_step;
  bool isIdle;

} stepMotorState_T;

FspTimer timerA;
FspTimer timerB;

void stepper1_timer_cb(timer_callback_args_t *);
void stepper2_timer_cb(timer_callback_args_t *);

/* Configuration structure for the steppers.*/
const stepMotorConf_T stepper_conf[NUMBER_OF_STEPPER_MOTORS] = 
{
  {.dirPin = 6, .stepPin = 7 , .enablePin = 8, .timer = &timerA , .callback = stepper1_timer_cb }, /* MOTOR_1 */
  {.dirPin = 0, .stepPin = 1 , .enablePin = 2, .timer = &timerB , .callback = stepper2_timer_cb }  /* MOTOR_2 */
};

volatile stepMotorState_T stepper_state[NUMBER_OF_STEPPER_MOTORS];

/**
 * @brief Initialize all stepper motors and associated timers.
 *
 * Configures GPIO pins, initializes timer instances, and prepares
 * internal state structures. Must be called once at startup before
 * using any other stepper functions.
 */
void Stepper_Init(void)
{
  for (int x = 0; x < NUMBER_OF_STEPPER_MOTORS; x++)  
  {
    uint8_t timerIndex;
    uint8_t type = GPT_TIMER;
    volatile stepMotorState_T * state_ptr = &stepper_state[x];
    const stepMotorConf_T * conf_ptr = &stepper_conf[x];

    state_ptr->step_target = 0;
    state_ptr->curr_step = 0;
    state_ptr->isIdle = true;

    pinMode(conf_ptr->dirPin, OUTPUT);
    pinMode(conf_ptr->stepPin, OUTPUT);
    pinMode(conf_ptr->enablePin, OUTPUT);

    // Get an available timer (GPT)
    type = GPT_TIMER;
    int8_t channel = FspTimer::get_available_timer(type);
    
    conf_ptr->timer->begin(TIMER_MODE_PERIODIC, type, channel, 1000.0f, 1.000f, conf_ptr->callback, nullptr);

    conf_ptr->timer->setup_overflow_irq();
    conf_ptr->timer->open();
  }
}

/**
 * @brief Start a stepper motor using timer-driven interrupts.
 *
 * This function initiates non-blocking motion. The motor will step
 * at the specified interval until the target number of steps is reached.
 *
 * @param motor    Stepper motor ID
 * @param interval Time between full steps in microseconds
 * @param dir      Direction of motion (0 = one direction, 1 = opposite)
 * @param target   Number of steps to execute
 */
void Stepper_StartNonBlocking(stepMotor_Id motor, uint32_t interval, uint8_t dir, uint32_t target)
{
  const stepMotorConf_T * conf_ptr;
  
  if (motor < NUMBER_OF_STEPPER_MOTORS)
  {
    conf_ptr = &stepper_conf[motor];
    
    if (stepper_state[motor].isIdle == true)
    {
      if (dir)
      {
        digitalWrite(conf_ptr->dirPin, HIGH);
      }
      else
      {
        digitalWrite(conf_ptr->dirPin, LOW);
      }
    
      digitalWrite(conf_ptr->enablePin, LOW);

      stepper_state[motor].step_target = target;
      stepper_state[motor].curr_step = 0;
      stepper_state[motor].isIdle = false;

      conf_ptr->timer->set_period_us(interval / 2);
      conf_ptr->timer->start();
    }
  }
}

/**
 * @brief Stop a running stepper motor.
 *
 * Stops the associated timer, marks the motor as idle, and disables
 * the motor driver.
 *
 * @param motor Stepper motor ID
 */
void Stepper_Stop(stepMotor_Id motor)
{
  if (motor < NUMBER_OF_STEPPER_MOTORS)
  {
    stepper_conf[motor].timer->stop();
    stepper_state[motor].isIdle = true;
    digitalWrite(stepper_conf[motor].enablePin, HIGH);
  }
}

/**
 * @brief Perform a blocking stepper motor movement.
 *
 * Spins the motor for a specified number of steps. This function blocks
 * execution until all steps are completed, and therefore cannot be used
 * for simultaneous multi-motor control.
 *
 * @param motor            Stepper motor ID
 * @param interval         Time between full steps in microseconds
 * @param dir              Direction of motion (0 = one direction, 1 = opposite)
 * @param number_of_steps  Total number of steps to execute
 */
void Stepper_MoveBlocking(stepMotor_Id motor, uint32_t interval, uint8_t dir, uint32_t number_of_steps)
{
  if (motor < NUMBER_OF_STEPPER_MOTORS)
  {
    const stepMotorConf_T * conf_ptr = &stepper_conf[motor];

    if (stepper_state[motor].isIdle == true)
    {
      if (dir)
      {
        digitalWrite(conf_ptr->dirPin, HIGH);
      }
      else
      {
        digitalWrite(conf_ptr->dirPin, LOW);
      }

      digitalWrite(conf_ptr->enablePin, LOW);

      // Spin the stepper motor 1 revolution slowly:
      for (int i = 0; i < number_of_steps; i++) 
      {
        Stepper_StepOnce(motor, interval);
      }

      digitalWrite(conf_ptr->enablePin, HIGH);
    }
  }
}

/**
 * @brief Execute a single step on the stepper motor.
 *
 * Generates one step pulse using a blocking delay. The enable pin must
 * be managed externally before and after calling this function.
 *
 * @param motor   Stepper motor ID
 * @param interval Time between full steps in microseconds
 */
void Stepper_StepOnce(stepMotor_Id motor, int interval)
{
  const stepMotorConf_T * conf_ptr = &stepper_conf[motor];

    // These four lines result in 1 step:
  digitalWrite(conf_ptr->stepPin, HIGH);
  delayMicroseconds(interval / 2);
  digitalWrite(conf_ptr->stepPin, LOW);
  delayMicroseconds(interval / 2);
}

/**
 * @brief Check if any stepper motor is currently active.
 *
 * @return true  At least one motor is running
 * @return false All motors are idle
 */
bool Stepper_IsBusy(void)
{ 
  bool res = false;
  for (int x = 0; x < NUMBER_OF_STEPPER_MOTORS; x++)
  {
    if(stepper_state[x].isIdle == false)
    {
      res = true;
    }
  }

  return res;
}

/**
 * @brief Timer interrupt callback for Stepper Motor 1.
 *
 * Toggles the step pin to generate pulses. Step count is incremented
 * on the rising edge. Stops the motor when the target step count is reached.
 *
 * @param args Timer callback arguments (unused)
 */
void stepper1_timer_cb(timer_callback_args_t *)
{
  bool level = !digitalRead(stepper_conf[MOTOR_1].stepPin);
  digitalWrite(stepper_conf[MOTOR_1].stepPin, level);

  /* Count only rising edge. */
  if(level)
  {
    stepper_state[MOTOR_1].curr_step++;
  }

  if (stepper_state[MOTOR_1].curr_step >= stepper_state[MOTOR_1].step_target)
  {
    Stepper_Stop(MOTOR_1);
  }
}

/**
 * @brief Timer interrupt callback for Stepper Motor 2.
 *
 * Toggles the step pin to generate pulses. Step count is incremented
 * on the rising edge. Stops the motor when the target step count is reached.
 *
 * @param args Timer callback arguments (unused)
 */
void stepper2_timer_cb(timer_callback_args_t *)
{
  bool level = !digitalRead(stepper_conf[MOTOR_2].stepPin);
  digitalWrite(stepper_conf[MOTOR_2].stepPin, level);
  
  /* Count only rising edge. */
  if(level)
  {
    stepper_state[MOTOR_2].curr_step++;
  }

  if (stepper_state[MOTOR_2].curr_step >= stepper_state[MOTOR_2].step_target)
  {
    Stepper_Stop(MOTOR_2);
  }
}
