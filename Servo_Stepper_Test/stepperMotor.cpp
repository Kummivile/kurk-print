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

const stepMotorConf_T stepper_conf[NUMBER_OF_STEPPER_MOTORS] =
{
  {.dirPin = 6, .stepPin = 7, .enablePin = 8, .timer = &timerA, .callback = stepper1_timer_cb},
  {.dirPin = 0, .stepPin = 1, .enablePin = 2, .timer = &timerB, .callback = stepper2_timer_cb}
};

volatile stepMotorState_T stepper_state[NUMBER_OF_STEPPER_MOTORS];

void Stepper_Init(void)
{
  for (int x = 0; x < NUMBER_OF_STEPPER_MOTORS; x++)
  {
    uint8_t type = GPT_TIMER;
    volatile stepMotorState_T * state_ptr = &stepper_state[x];
    const stepMotorConf_T * conf_ptr = &stepper_conf[x];

    state_ptr->step_target = 0;
    state_ptr->curr_step = 0;
    state_ptr->isIdle = true;

    pinMode(conf_ptr->dirPin, OUTPUT);
    pinMode(conf_ptr->stepPin, OUTPUT);
    pinMode(conf_ptr->enablePin, OUTPUT);

    int8_t channel = FspTimer::get_available_timer(type);

    conf_ptr->timer->begin(TIMER_MODE_PERIODIC, type, channel, 1000.0f, 1.000f, conf_ptr->callback, nullptr);
    conf_ptr->timer->setup_overflow_irq();
    conf_ptr->timer->open();
  }
}

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

void Stepper_Stop(stepMotor_Id motor)
{
  if (motor < NUMBER_OF_STEPPER_MOTORS)
  {
    stepper_conf[motor].timer->stop();
    stepper_state[motor].isIdle = true;
    digitalWrite(stepper_conf[motor].enablePin, HIGH);
  }
}

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

      for (int i = 0; i < number_of_steps; i++)
      {
        Stepper_StepOnce(motor, interval);
      }

      digitalWrite(conf_ptr->enablePin, HIGH);
    }
  }
}

void Stepper_StepOnce(stepMotor_Id motor, int interval)
{
  const stepMotorConf_T * conf_ptr = &stepper_conf[motor];

  digitalWrite(conf_ptr->stepPin, HIGH);
  delayMicroseconds(interval / 2);
  digitalWrite(conf_ptr->stepPin, LOW);
  delayMicroseconds(interval / 2);
}

bool Stepper_IsBusy(void)
{
  bool res = false;
  for (int x = 0; x < NUMBER_OF_STEPPER_MOTORS; x++)
  {
    if (stepper_state[x].isIdle == false)
    {
      res = true;
    }
  }

  return res;
}

void stepper1_timer_cb(timer_callback_args_t *)
{
  bool level = !digitalRead(stepper_conf[MOTOR_1].stepPin);
  digitalWrite(stepper_conf[MOTOR_1].stepPin, level);

  if (level)
  {
    stepper_state[MOTOR_1].curr_step++;
  }

  if (stepper_state[MOTOR_1].curr_step >= stepper_state[MOTOR_1].step_target)
  {
    Stepper_Stop(MOTOR_1);
  }
}

void stepper2_timer_cb(timer_callback_args_t *)
{
  bool level = !digitalRead(stepper_conf[MOTOR_2].stepPin);
  digitalWrite(stepper_conf[MOTOR_2].stepPin, level);

  if (level)
  {
    stepper_state[MOTOR_2].curr_step++;
  }

  if (stepper_state[MOTOR_2].curr_step >= stepper_state[MOTOR_2].step_target)
  {
    Stepper_Stop(MOTOR_2);
  }
}
