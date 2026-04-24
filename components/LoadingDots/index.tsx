import React from 'react';
import './style.css';

export default function LoadingDots() {
  return (
    <div className="ai-loading-dots" aria-label="Loading" role="status">
      <span className="ai-loading-dot" />
      <span className="ai-loading-dot" />
      <span className="ai-loading-dot" />
    </div>
  );
}

