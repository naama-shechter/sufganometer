package com.sufganometer.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // תוסף מקומי: קריאת מונה הצעדים הגולמי, כדי לספור גם צעדים שנעשו כשהאפליקציה ברקע
        registerPlugin(StepSensorPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
