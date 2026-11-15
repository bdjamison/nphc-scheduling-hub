# Approver reservation retrieval indicator
When an approver clicks a calendar event, a modal immediately displays an animated spinner and **Retrieving...** while the existing approvals API request loads the reservation details. It closes on success or failure; the existing error message remains available on failure. Public calendar behavior and API/backend code are unchanged.
