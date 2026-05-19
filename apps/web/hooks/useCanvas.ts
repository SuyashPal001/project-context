'use client';

import { useState, useCallback, useRef } from 'react';
import type { CanvasAction, CanvasEventData } from '@/components/platform/canvas/types';

export function useCanvas() {
  const [isCanvasOpen, setIsCanvasOpen] = useState(false);
  const [hasActivity, setHasActivity] = useState(false);
  const activityTimeoutRef = useRef<NodeJS.Timeout>(null);
  const pendingActionsRef = useRef<Array<{ action: CanvasAction; data: CanvasEventData }>>([]);

  const [isCanvasExpanded, setIsCanvasExpanded] = useState(false);

  // Toggle canvas panel
  const toggleCanvas = useCallback(() => {
    setIsCanvasOpen(prev => {
        if (prev) setIsCanvasExpanded(false); // reset expand when closing
        return !prev;
    });
  }, []);

  const toggleExpand = useCallback(() => {
    setIsCanvasExpanded(prev => !prev);
  }, []);

  // Open canvas
  const openCanvas = useCallback(() => {
    setIsCanvasOpen(true);
  }, []);

  // Close canvas
  const closeCanvas = useCallback(() => {
    setIsCanvasOpen(false);
    setIsCanvasExpanded(false);
  }, []);

  // Handle canvas update (called from useAgentEvents)
  const handleCanvasUpdate = useCallback((action: CanvasAction, data: CanvasEventData) => {
    console.log('[canvas] handleCanvasUpdate:', action, data);
    console.log('[canvas] window.__canvasUpdate exists:', !!(window as any).__canvasUpdate);
    // Auto-open canvas when browser automation or artifact streaming starts/loads
    if (!isCanvasOpen && (action === 'screenshot' || action === 'artifact_start' || action === 'artifact_load')) {
      setIsCanvasOpen(true);
    }

    // Show activity indicator
    setHasActivity(true);
    
    // Clear previous timeout
    if (activityTimeoutRef.current) {
      clearTimeout(activityTimeoutRef.current);
    }
    
    // Reset activity indicator after 3 seconds of no activity
    activityTimeoutRef.current = setTimeout(() => {
      setHasActivity(false);
    }, 3000);

    // Forward to canvas component; queue if not mounted yet
    if (typeof window !== 'undefined') {
      if ((window as any).__canvasUpdate) {
        (window as any).__canvasUpdate(action, data);
      } else {
        pendingActionsRef.current.push({ action, data });
      }
    }
  }, [isCanvasOpen]);

  const flushPending = useCallback(() => {
    if (pendingActionsRef.current.length === 0) return;
    const queue = [...pendingActionsRef.current];
    pendingActionsRef.current = [];
    queue.forEach(({ action, data }) => {
      if ((window as any).__canvasUpdate) {
        (window as any).__canvasUpdate(action, data);
      }
    });
  }, []);

  // Reset canvas state
  const resetCanvas = useCallback(() => {
    setHasActivity(false);
    if (typeof window !== 'undefined' && (window as any).__canvasReset) {
      (window as any).__canvasReset();
    }
  }, []);

  return {
    isCanvasOpen,
    isCanvasExpanded,
    hasActivity,
    toggleCanvas,
    toggleExpand,
    openCanvas,
    closeCanvas,
    handleCanvasUpdate,
    resetCanvas,
    flushPending,
  };
}
