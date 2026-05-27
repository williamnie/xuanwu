package api

import (
	"net"
	"net/url"
	"strings"
)

type securityStatus struct {
	Warnings []securityWarning `json:"warnings,omitempty"`
}

type securityWarning struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func buildSecurityStatus(cfg SystemConfig) securityStatus {
	warnings := []securityWarning{}
	if bindsAllInterfaces(cfg.Addr) {
		warnings = append(warnings, securityWarning{
			Code: "bind_all_interfaces", Message: "service listens on all interfaces",
		})
	}
	if !cfg.AuthEnabled {
		warnings = append(warnings, securityWarning{
			Code: "auth_disabled", Message: "API bearer token auth is disabled",
		})
	}
	if originPolicyName(cfg.AllowedOrigins) == "wildcard" {
		warnings = append(warnings, securityWarning{
			Code: "origin_wildcard", Message: "Origin/CORS policy allows any site",
		})
	}
	return securityStatus{Warnings: warnings}
}

func cleanAllowedOrigins(origins []string) []string {
	out := make([]string, 0, len(origins))
	for _, origin := range origins {
		origin = strings.TrimSpace(origin)
		if origin != "" {
			out = append(out, origin)
		}
	}
	return out
}

func originPolicyName(origins []string) string {
	if len(origins) == 0 {
		return "local_only"
	}
	for _, origin := range origins {
		if strings.TrimSpace(origin) == "*" {
			return "wildcard"
		}
	}
	return "allowlist"
}

func originAllowed(origin, host string, allowed []string) bool {
	origin = strings.TrimSpace(origin)
	if origin == "" {
		return true
	}
	for _, candidate := range allowed {
		if candidate == "*" || strings.EqualFold(candidate, origin) {
			return true
		}
	}
	u, err := url.Parse(origin)
	if err != nil || u.Hostname() == "" {
		return false
	}
	return isLocalHost(u.Hostname()) || strings.EqualFold(origin, requestOrigin(host))
}

func requestOrigin(host string) string {
	host = strings.TrimSpace(host)
	if host == "" {
		return ""
	}
	return "http://" + host
}

func bindsAllInterfaces(addr string) bool {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return false
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return strings.HasPrefix(addr, ":")
	}
	host = strings.Trim(host, "[]")
	return host == "" || host == "0.0.0.0" || host == "::"
}

func isLocalHost(host string) bool {
	host = strings.Trim(strings.ToLower(host), "[]")
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}
