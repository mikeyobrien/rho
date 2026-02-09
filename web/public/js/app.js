document.addEventListener('alpine:init', () => {
  Alpine.data('rhoApp', () => ({
    view: 'chat',
    setView(nextView) {
      this.view = nextView;
    }
  }));
});
