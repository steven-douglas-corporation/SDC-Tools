# SDC Assemblies Library

![Version](https://img.shields.io/github/v/release/steven-douglas-corporation/SDC-Tools?style=for-the-badge)
![Status](https://img.shields.io/badge/Status-Production--Ready-success?style=for-the-badge)
![Platform](https://img.shields.io/badge/Platform-Windows-blue?style=for-the-badge)

A high-fidelity, high-performance CAD Assembly management system designed for engineering teams. Modernized with a stone-themed aesthetic, real-time sync capabilities, and a robust Electron-powered desktop experience.

## ✨ Key Features

- **🚀 Advanced Search & Filter**: Instant, high-performance filtering by Job ID, Category, Model presence, and more.
- **🎨 High-Fidelity UI**: Premium dark mode implementation with a sophisticated "Stone" palette and glassmorphism elements.
- **📦 Desktop Native**: Fully packaged Windows application with seamless installation and auto-updates.
- **⚡ Smart Sync**: Dynamic synchronization with SolidWorks assembly data and automatic thumbnail extraction.
- **🔄 Auto-Updates**: Continuous delivery via GitHub Actions ensures every installed instance is always up-to-date.

## 🛠 Tech Stack

- **Frontend**: React, Vite, Vanilla CSS (High-Fidelity Design System)
- **Backend**: Node.js, Express, SQLite (Better-SQLite3)
- **Desktop**: Electron, Electron Builder, Electron Updater
- **CI/CD**: GitHub Actions

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Git](https://git-scm.com/)
- SolidWorks (required for thumbnail extraction sync)

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/steven-douglas-corporation/SDC-Tools.git
   cd SDC-Tools/apps/assemblies
   ```

2. **Install Dependencies**
   ```bash
   npm install
   ```

3. **Development Mode**
   ```bash
   npm run dev
   ```

4. **Electron Development**
   ```bash
   npm run electron:dev
   ```

## 📦 Deployment & Updates

This application is configured for **Continuous Deployment**. When a new tag is pushed to the main branch, GitHub Actions will:

1. Build the production React assets.
2. Package the Electron application as an `.exe` setup.
3. Publish the release to GitHub.
4. Trigger auto-updates for all currently installed applications.

### Manual Build
To manually generate a portable `.exe`:
```bash
npm run electron:build
```

## 📁 Architecture Overview

- `/client`: Modern React frontend with a custom design system.
- `/server`: Express API managing SQLite data and PowerShell extraction scripts.
- `/electron`: Main and Preload scripts for the desktop shell.
- `/database`: Centralized data storage (synced via N:/ drive for multi-user access).

## 📄 License

This project is proprietary and confidential.

---
Built with ❤️ by the SDC Advanced Engineering Team
