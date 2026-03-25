# Code Refactoring Plan - Bite-Sized Tasks

## Overview
Three files are too large and need to be broken down for maintainability:
- `frontend/src/App.tsx` (1,961 lines)
- `backend/main.py` (1,150 lines)
- `ai_client.py` (1,106 lines)

## Priority Ranking (Easiest → Hardest)

### Phase 1: ai_client.py (Low-hanging fruit, low risk)
**Why first:** Prompts are just large strings. Extracting them gives immediate ~400 line reduction with zero logic changes.

#### Task 1.1: Extract all prompt strings to separate files
- Create `ai_client/prompts/` directory
- Move these prompts to individual `.txt` files:
  - `classification_prompt.txt` (ImageClassifier.CLASSIFICATION_PROMPT)
  - `grouping_prompt.txt` (GarmentGrouper.GROUPING_PROMPT)
  - `extraction_prompt.txt` (VendoraExtractor.EXTRACTION_PROMPT)
  - `batch_extraction_prompt.txt` (VendoraExtractor.BATCH_EXTRACTION_PROMPT)
  - `vibe_description_prompt.txt` (VendoraExtractor.VIBE_DESCRIPTION_PROMPT)
- Update ai_client.py to load prompts from files at runtime
- **Impact:** -400 lines, prompts now editable without touching code

#### Task 1.2: Split ImageClassifier into its own module
- Create `ai_client/classifiers/image_classifier.py`
- Move ImageClassifier class + its prompt loading
- Update imports in main ai_client.py
- **Impact:** -200 lines from ai_client.py

#### Task 1.3: Split GarmentGrouper into its own module
- Create `ai_client/groupers/garment_grouper.py`
- Move GarmentGrouper class + its prompt loading
- Update imports
- **Impact:** -250 lines from ai_client.py

#### Task 1.4: Split VendoraExtractor into its own module
- Create `ai_client/extractors/vendora_extractor.py`
- Move VendoraExtractor class + its prompt loading
- Update imports
- **Impact:** -300 lines from ai_client.py

#### Task 1.5: Create factory functions in separate file
- Create `ai_client/factory.py` with `create_ai_client()` and `create_full_ai_client()`
- Remove from main ai_client.py
- **Impact:** Cleaner organization

**After Phase 1:** ai_client.py becomes ~50 lines (just imports + factory re-exports)

---

### Phase 2: backend/main.py (Medium complexity, moderate risk)
**Why second:** Clear module boundaries exist, but need careful import management.

#### Task 2.1: Extract Pydantic models to separate file
- Create `backend/api/models.py`
- Move: ItemUpdate, ModelUpdateRequest, RestorePhotoRequest, RecombineRequest
- Update imports in main.py
- **Impact:** -50 lines, cleaner API layer

#### Task 2.2: Extract WebSocket manager to separate module
- Create `backend/api/websocket.py` or `backend/core/websocket_manager.py`
- Move ConnectionManager class + related functions
- Update imports
- **Impact:** -80 lines, WebSocket logic isolated

#### Task 2.3: Extract API routes by endpoint group
- Create `backend/api/routes/` directory:
  - `pipeline.py` - /api/start, /api/stop, /api/clear, /api/state, /api/refresh
  - `images.py` - /api/images, /api/output, /api/item-photo, /api/item-photo/restore, /api/open-*
  - `models.py` - /api/models, /api/model
  - `recombine.py` - /api/recombine-items
- Create `backend/api/__init__.py` to include all routers
- Refactor main.py to use FastAPI routers
- Update imports
- **Impact:** -400 lines, routes organized by feature

#### Task 2.4: Move pipeline logic to separate module
- Create `backend/core/pipeline.py`
- Move: run_pipeline(), group_images(), extract_and_file()
- Update imports
- **Impact:** -300 lines, business logic separated

#### Task 2.5: Move PipelineState to its own file
- Create `backend/core/state.py`
- Move PipelineState class + related functions (sanitize_folder_name, get_next_output_index, load_state_from_disk)
- Update imports
- **Impact:** -150 lines, state management isolated

#### Task 2.6: Move utility functions to utils module
- Create `backend/utils/helpers.py`
- Move: open_folder_with_explorer, signal_handler
- Update imports
- **Impact:** -50 lines

#### Task 2.7: Clean up main.py to just app setup
- main.py should only contain:
  - Imports
  - FastAPI app creation with middleware
  - Include routers from api/
  - Startup event
  - uvicorn.run()
- **Impact:** main.py becomes ~50 lines

**After Phase 2:** Clean separation: API routes, business logic, state management, utilities all in separate modules.

---

### Phase 3: frontend/src/App.tsx (High complexity, requires careful component design)
**Why last:** Most complex UI refactoring, needs thorough testing after each step.

#### Task 3.1: Extract all TypeScript interfaces to separate file
- Create `frontend/src/types/index.ts`
- Move all interfaces: LogEntry, ExtractedItem, PipelineState, WSMessage, PipelineProgress, etc.
- Update imports
- **Impact:** -100 lines, types centralized

#### Task 3.2: Extract API service functions
- Create `frontend/src/services/api.ts`
- Move all `async function getState()`, `async function startPipeline()`, etc.
- Update to use proper error handling and typing
- **Impact:** -150 lines, API calls centralized

#### Task 3.3: Extract WebSocket hook
- Create `frontend/src/hooks/useWebSocket.ts`
- Move useWebSocket hook (lines 218-251)
- Update imports
- **Impact:** -40 lines, reusable hook

#### Task 3.4: Extract all SVG icons to separate component file
- Create `frontend/src/components/Common/Icons.tsx`
- Move Icons object (lines 253-285)
- Convert to proper React components with TypeScript
- Update imports
- **Impact:** -40 lines, icons reusable

#### Task 3.5: Extract Dashboard view to separate component
- Create `frontend/src/components/Dashboard/Dashboard.tsx`
- Move renderDashboard function (lines 726-919) + all its sub-components
- Extract inline styles to CSS classes or styled-components
- Update App.tsx to render `<Dashboard />`
- **Impact:** -200 lines, dashboard isolated

#### Task 3.6: Extract Editor view to separate component
- Create `frontend/src/components/Editor/Editor.tsx`
- Move renderEditor function (lines 922-1692) + all sub-components
- Extract inline styles to CSS classes
- Update App.tsx to render `<Editor />`
- **Impact:** -800 lines, editor isolated

#### Task 3.7: Extract Editor sub-components
Within Editor component, further split:
- `Sidebar/ItemList.tsx` - The filteredItems.map() rendering
- `Sidebar/SidebarItem.tsx` - Individual item component
- `Preview/ImagePreview.tsx` - The preview image with magnifier
- `Preview/ThumbnailGrid.tsx` - Thumbnail navigation
- `Metadata/MetadataForm.tsx` - All form fields
- `Metadata/FieldRow.tsx` - Row of input fields
- `Metadata/TextAreaField.tsx` - Description textarea
- `CombineDialog.tsx` - The combine modal (already separate function)

**Impact:** Editor becomes manageable ~200-300 lines

#### Task 3.8: Extract common UI components
- `components/Common/Button.tsx` - All button styles
- `components/Common/Card.tsx` - Card wrapper
- `components/Common/Input.tsx` - Styled input fields
- `components/Common/Select.tsx` - Styled select dropdowns

#### Task 3.9: Move all inline styles to CSS modules or Tailwind
- Replace `style={{...}}` with className references
- Create `frontend/src/styles/App.css` or use Tailwind utilities
- **Impact:** Massive reduction in JSX clutter

#### Task 3.10: Simplify state management
- Consider extracting complex state to custom hooks:
  - `useEditorState.ts` - All editor-related state
  - `usePipelineState.ts` - Pipeline state + WebSocket updates
  - `useImageNavigation.ts` - Preview image navigation
- Or consider Zustand/Redux if state is too complex for hooks

**After Phase 3:** App.tsx becomes ~100 lines (just routing, tab state, and component composition)

---

## Implementation Order

**Recommended sequence:**
1. Complete all Phase 1 tasks (ai_client.py) - 2-3 hours
2. Complete all Phase 2 tasks (backend/main.py) - 3-4 hours
3. Start Phase 3 tasks (App.tsx) - begin with Tasks 3.1-3.5 (types, services, hooks, icons, dashboard) - 2-3 hours
4. Continue Phase 3 with Tasks 3.6-3.7 (editor split) - 3-4 hours
5. Finish Phase 3 with Tasks 3.8-3.10 (styles, state management) - 2-3 hours

**Total estimated time:** 12-17 hours of focused refactoring work.

---

## Success Criteria

After refactoring:
- No file exceeds 500 lines
- Each module/component has a single, clear responsibility
- Prompts are editable without touching Python code
- Components are reusable and well-typed
- Tests can be written for individual modules easily
- New developers can understand the codebase quickly

---

## Risk Mitigation

- **Commit after each task** - allows rollback if something breaks
- **Run existing functionality after each task** - ensure no regressions
- **Keep git branch for refactoring** - don't mix with feature work
- **Test both frontend and backend after each phase** - catch integration issues early
- **Document any tricky parts** - add comments where behavior is non-obvious

---

## Notes

- The frontend uses inline styles for quick prototyping. Consider migrating to Tailwind CSS classes or CSS modules for maintainability.
- The backend mixes sync/async code. Keep async patterns consistent when splitting.
- The AI prompts are extremely detailed. Keep them in separate `.txt` files for easy editing by non-developers (product managers, prompt engineers).