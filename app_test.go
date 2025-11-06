package main

import "testing"

func TestOcrReq(t *testing.T) {
	app := NewApp()

	reqTest := app.ReqAPI("test_1.png")
	if reqTest != "这是一个测试" {
		t.Errorf("Something went wrong - was expecting 这是一个测试 but got %q", reqTest)
	}

}
