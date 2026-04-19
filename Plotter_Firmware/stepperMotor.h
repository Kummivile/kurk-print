#ifndef STEPPER_MOTOR_H
#define STEPPER_MOTOR_H

#include "Arduino.h"

typedef enum 
{
  MOTOR_1,
  MOTOR_2,

  NUMBER_OF_STEPPER_MOTORS
} stepMotor_Id;

void Stepper_Init(void);
void Stepper_StartNonBlocking(stepMotor_Id motor, uint32_t interval, uint8_t dir, uint32_t target);
void Stepper_Stop(stepMotor_Id motor);
bool Stepper_IsBusy(void);
void Stepper_MoveBlocking(stepMotor_Id motor, uint32_t interval, uint8_t dir, uint32_t number_of_steps);
void Stepper_StepOnce(stepMotor_Id motor, int interval);
void Stepper_SetDirection(stepMotor_Id motor, uint8_t dir);
void Stepper_SetEnabled(stepMotor_Id motor, bool enabled);

#endif
