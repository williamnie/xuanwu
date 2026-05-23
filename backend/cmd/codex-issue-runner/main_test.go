package main

import "testing"

func TestCommandModeKeepsDefaultServeCompatibility(t *testing.T) {
	serve, args := commandMode([]string{"--addr", "127.0.0.1:3999"})
	if !serve || len(args) != 2 || args[0] != "--addr" {
		t.Fatalf("expected default serve mode, serve=%v args=%v", serve, args)
	}
}

func TestCommandModeAcceptsExplicitServe(t *testing.T) {
	serve, args := commandMode([]string{"serve", "--db", "/tmp/app.db"})
	if !serve || len(args) != 2 || args[0] != "--db" {
		t.Fatalf("expected explicit serve mode, serve=%v args=%v", serve, args)
	}
}

func TestCommandModeRoutesIssueToCLI(t *testing.T) {
	serve, args := commandMode([]string{"issue", "create"})
	if serve || len(args) != 2 || args[0] != "issue" {
		t.Fatalf("expected cli mode, serve=%v args=%v", serve, args)
	}
}

func TestCommandModeRoutesSystemStatusToCLI(t *testing.T) {
	serve, args := commandMode([]string{"system", "status"})
	if serve || len(args) != 2 || args[0] != "system" {
		t.Fatalf("expected cli mode, serve=%v args=%v", serve, args)
	}
}
